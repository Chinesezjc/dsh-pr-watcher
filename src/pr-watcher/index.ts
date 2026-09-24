/**
 * Host service for `dsh-pr-watcher`: owns a set of PR watches, polls each one
 * through the `gh` CLI on a configurable interval, and delivers a notification
 * message into the target agent session when the watch's conditions flip to
 * satisfied or when observed state changes.
 *
 * The service registers as `ctx.prWatcher`. Delivery reuses the same agent
 * inbox methods as the host (`inject`/`followup`/`steer`) and refuses sessions
 * that belong to a subagent, exactly like the host's own handoff paths.
 * @module dsh-pr-watcher
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  buildNotificationText,
  conditionsMet,
  diffSnapshots,
  evaluateConditions,
  filterCommentAuthors,
} from './conditions.ts'
import {
  conversationCountsChanged,
  fetchAuthenticatedLogin,
  fetchBranchSnapshot,
  fetchConversation,
  ghGraphql,
  parseRepo,
  PR_QUERY,
  snapshotFromGraphql,
} from './gh.ts'
import {
  DEFAULT_CONDITIONS,
  hasChanges,
  isConditionName,
  type BranchSnapshot,
  type ConditionName,
  type ConversationEntry,
  type DeliveryMode,
  type DeliveryResult,
  type PrSnapshot,
  type QueryResult,
  type WatchNotifyInfo,
  type WatchResult,
  type WatchSnapshot,
  type WatchSpec,
  type WatchStatus,
} from './types.ts'

/**
 * Mirror of the Host's subagent-ownership predicate (the Host does not export
 * it; copied verbatim and kept in sync, since this is a delivery safety fence).
 */
function isSessionOwnedBySubagent(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    prWatcher: PrWatcherService
  }
  interface Events {
    /**
     * Emitted when a watch notification is delivered (or refused). The payload
     * carries the watch id, whether it was the satisfied transition, the change
     * summary when a change notification, and the delivery outcome.
     * @mode emit
     */
    'pr-watcher/notify'(info: WatchNotifyInfo): void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Attribution of a notification this plugin delivered. Session format V4
     * refuses the retired `{ kind: 'plugin', plugin }` wrapper, so the producer
     * kind stands alone: the name is exactly what the harness's V3-to-V4
     * migration writes for this plugin's already-persisted notifications
     * (`plugin:` plus the original plugin name), keeping migrated rows and rows
     * written from now on under one producer identity.
     */
    'plugin:dsh-pr-watcher': { readonly kind: 'plugin:dsh-pr-watcher' } & ContextFormed
  }
}

/** One registered watch plus its runtime state. */
interface WatchState {
  readonly spec: WatchSpec
  snapshot: WatchSnapshot | undefined
  satisfied: boolean
  notified: boolean
  lastError: string | undefined
  lastPolledAt: string | undefined
  /** Consecutive fetch failures; drives the exponential backoff window. */
  failures: number
  /** Epoch ms before which the next poll of this watch is skipped. */
  nextAttemptAt: number
}

/** Version tag of the persisted watch file, bumped on format change. */
const PERSIST_VERSION = 1
/** Backoff base for consecutive gh failures (doubles per failure). */
const BACKOFF_BASE_MS = 30_000
/** Backoff ceiling. */
const BACKOFF_MAX_MS = 600_000

function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
}

/** First pause when GitHub reports an exhausted point budget; doubles per consecutive report. */
const THROTTLE_BASE_MS = 120_000
/** Ceiling for the service-wide pause after an exhausted point budget. */
const THROTTLE_MAX_MS = 1_800_000
/**
 * First pause after a secondary (abuse-detection) rate limit; doubles per
 * consecutive report. GitHub's secondary limit clears in minutes, so pausing
 * for the point-budget ceiling would silence the service long after the limit
 * lifted.
 */
const THROTTLE_SECONDARY_BASE_MS = 60_000
/** Ceiling for the service-wide pause after a secondary rate limit. */
const THROTTLE_SECONDARY_MAX_MS = 300_000
/** Delay between two watch polls inside one cycle, so a cycle never bursts. */
const POLL_PACING_MS = 250

/**
 * Whether a `gh` failure reports a GitHub rate limit. Covers the primary limit
 * ("API rate limit already exceeded") and the secondary one ("You have exceeded
 * a secondary rate limit"); the second is not visible in `gh api rate_limit`,
 * so it can only be recognized from the failure text.
 * @param message - the failure text.
 * @returns whether the failure is a rate limit.
 */
export function isRateLimitMessage(message: string): boolean {
  return /rate.?limit/i.test(message)
}

/**
 * Whether a rate-limit failure is GitHub's secondary (abuse-detection) limit
 * rather than an exhausted point budget. The two need different pauses: the
 * point budget resets on an hourly window, while the secondary limit clears in
 * minutes. Recognized from the failure text, because the secondary limit does
 * not appear in `gh api rate_limit`.
 * @param message - the failure text.
 * @returns whether the failure is the secondary limit.
 */
export function isSecondaryRateLimitMessage(message: string): boolean {
  return /secondary rate limit|abuse/i.test(message)
}

/**
 * Identity of one fetch target. Watches that name the same pull request or the
 * same branch head read one snapshot per cycle, so the key decides which
 * watches share a request.
 * @param target - the parsed target of a watch.
 * @returns the key.
 */
function targetKey(target: { repo: string; number: number } | { repo: string; branch: string }): string {
  return 'number' in target ? `${target.repo}#${target.number}` : `${target.repo}@${target.branch}`
}

/**
 * Replace an indefinite `mergeable` with the last definite value. GitHub
 * computes a pull request's mergeability asynchronously and answers `UNKNOWN`
 * (or null) while that computation is queued; that is the absence of an answer,
 * not a state, so it must not read as a change, must not flip the
 * `mergeable`/`conflicted` conditions, and must not make a satisfied watch fire
 * again. Every other field is passed through unchanged.
 * @param next - the snapshot just fetched.
 * @param prev - the previous stored snapshot, when the watch has one.
 * @returns the snapshot with a definite `mergeable`.
 */
export function carryForwardMergeable(next: WatchSnapshot, prev: WatchSnapshot | undefined): WatchSnapshot {
  if (next.kind !== 'pr') return next
  if (next.mergeable === 'MERGEABLE' || next.mergeable === 'CONFLICTING') return next
  if (prev === undefined || prev.kind !== 'pr') return next
  return { ...next, mergeable: prev.mergeable }
}

/**
 * Validate the exactly-one-of `number`/`branch` target selection shared by the
 * config schema, the persisted records, and the runtime `watch()` call.
 * @param number - pull request number, when the watch targets a PR.
 * @param branch - branch name, when the watch targets a branch head.
 * @returns the target fields to spread into a watch spec.
 * @throws when neither or both are provided.
 */
function resolveTarget(
  number: number | undefined,
  branch: string | undefined,
): { number: number } | { branch: string } {
  const hasBranch = branch !== undefined && branch !== ''
  if ((number !== undefined) === hasBranch) {
    throw new Error('exactly one of number (pull request) or branch must be provided')
  }
  if (number !== undefined && (!Number.isInteger(number) || number < 1)) {
    throw new Error(`invalid pull request number ${number}`)
  }
  return hasBranch ? { branch: branch as string } : { number: number as number }
}

/** The target fields of one runtime watch, normalized from its spec. */
function specTarget(spec: WatchSpec): { repo: string; number: number } | { repo: string; branch: string } {
  return { repo: spec.repo, ...resolveTarget(spec.number, spec.branch) }
}

const deliverySchema = z.union([z.const('followup'), z.const('steer'), z.const('inject')])

const configWatchSchema = z.object({
  id: z.string(),
  repo: z.string(),
  number: z.natural().required(false),
  branch: z.string().required(false),
  // Condition names are validated by PrWatcherService.assertConditions at load.
  // A branch watch takes no conditions, so the ready-set default is applied in
  // the constructor for PR watches only.
  conditions: z.array(z.string()).required(false),
  // Change notifications are on by default; a static watch that only wants
  // the single satisfied notification sets this false.
  notifyChanges: z.boolean().default(true),
  // Comment filtering is on by default; absent uses the service default.
  ignoreOwnComments: z.boolean().required(false),
  sessionId: z.string().default(''),
  delivery: deliverySchema.required(false),
})

/** Resolved service config; the cordis loader applies schema defaults first. */
export interface Config {
  /** Interval between poll cycles; overlapping cycles are skipped, not queued. */
  readonly pollIntervalMs: number
  /**
   * Ceiling on the service's own GitHub GraphQL consumption, in points per
   * hour. One watch poll costs one point, and the account-wide budget (5000
   * points per hour) is shared with every other client using the same `gh`
   * account, so a large watch set would otherwise spend it alone and stall
   * every watch once the budget is gone. When the distinct watched targets
   * would exceed this ceiling, the effective poll interval stretches past
   * `pollIntervalMs`. 0 disables the ceiling.
   */
  readonly maxPointsPerHour: number
  /** Path or name of the `gh` executable. */
  readonly ghPath: string
  /** Per-`gh`-call timeout. */
  readonly ghTimeoutMs: number
  /** Default delivery mode for notifications. */
  readonly delivery: DeliveryMode
  /** Whether a notification may wake a persisted (not live) session. */
  readonly allowResume: boolean
  /** Default target session for static watches that omit their own sessionId. */
  readonly notifySessionId: string
  /**
   * Whether comments authored by the authenticated `gh` account are excluded
   * from change notifications by default. Per-watch `ignoreOwnComments`
   * overrides it. The account is shared with the operator, so a comment typed
   * on github.com as that account is filtered too.
   */
  readonly ignoreOwnComments: boolean
  /**
   * Additional logins whose comments never count as changes, applied to every
   * watch regardless of `ignoreOwnComments`.
   */
  readonly ignoreCommentAuthors: readonly string[]
  /** Static watches validated at load. */
  readonly watches: readonly ConfigWatch[]
  /**
   * File path for persisting runtime watches so they survive process
   * restarts. Empty disables persistence (runtime watches are ephemeral).
   */
  readonly stateFile: string
}

/** One static watch entry as configured in `Config.watches`. */
export interface ConfigWatch {
  readonly id: string
  /** Repository as `owner/name`. */
  readonly repo: string
  /** Pull request number; exactly one of `number`/`branch` is set. */
  readonly number?: number
  /** Watched branch head (e.g. `master`); exactly one of `number`/`branch` is set. */
  readonly branch?: string
  /** Condition names; validated by {@link PrWatcherService.assertConditions}. */
  readonly conditions?: readonly string[]
  readonly notifyChanges: boolean
  /** Per-watch override of `Config.ignoreOwnComments`; absent uses the config default. */
  readonly ignoreOwnComments?: boolean
  /** Target session; empty falls back to `Config.notifySessionId`. */
  readonly sessionId: string
  readonly delivery: DeliveryMode | undefined
}

const configSchema: Schemastery = z.object({
  /** Interval between poll cycles; overlapping cycles are skipped, not queued. */
  pollIntervalMs: z.natural().min(30000).max(3_600_000).default(60000),
  /**
   * Ceiling on this service's GitHub GraphQL points per hour, shared with every
   * other client on the same `gh` account. The effective interval stretches past
   * `pollIntervalMs` when the watched targets would exceed it. 0 disables it.
   */
  maxPointsPerHour: z.natural().max(100_000).default(2400),
  /** Path or name of the `gh` executable. */
  ghPath: z.string().default('gh'),
  /** Per-`gh`-call timeout. */
  ghTimeoutMs: z.natural().min(5000).max(120_000).default(30_000),
  /** Default delivery mode for notifications; `steer` cuts into the nearest step boundary. */
  delivery: deliverySchema.default('steer'),
  /** Whether a notification may wake a persisted (not live) session. */
  allowResume: z.boolean().default(true),
  /** Default target session for static watches that omit their own sessionId. */
  notifySessionId: z.string().default(''),
  /**
   * Filter comments authored by the authenticated `gh` account out of change
   * notifications. Per-watch `ignoreOwnComments` overrides this.
   */
  ignoreOwnComments: z.boolean().default(true),
  /** Additional logins whose comments never count as changes. */
  ignoreCommentAuthors: z.array(z.string()).default([]),
  /** Static watches validated at load. */
  watches: z.array(configWatchSchema).default([]),
  /**
   * File path for persisting runtime watches. Empty (default) keeps runtime
   * watches in memory only, so they vanish on process restart.
   */
  stateFile: z.string().default(''),
})

/**
 * Live PR watcher service, registered as `ctx.prWatcher`. Requires the live
 * agent registry; activation is availability-driven like every other host
 * service. Watches come from two sources: `Config.watches` (static, validated
 * at load) and runtime registrations through {@link PrWatcherService.watch}
 * (the model-facing tools surface these).
 */
export class PrWatcherService extends Service {
  static inject = ['agents']
  static Config = configSchema

  private readonly pollIntervalMs: number
  private readonly maxPointsPerHour: number
  private readonly ghPath: string
  private readonly ghTimeoutMs: number
  private readonly delivery: DeliveryMode
  private readonly allowResume: boolean
  private readonly ignoreOwnComments: boolean
  private readonly ignoreCommentAuthors: readonly string[]
  private readonly watches = new Map<string, WatchState>()
  private readonly stateFile: string
  /** Login of the authenticated gh account; undefined until resolved. */
  private selfLogin: string | undefined
  /** Whether a resolution attempt already succeeded (failures retry next poll). */
  private selfLoginResolved = false
  /** Whether the resolution failure was already logged. */
  private selfLoginWarned = false
  /** Epoch ms until which no watch is polled because GitHub throttled us. */
  private throttleUntil = 0
  /** Consecutive rate-limit reports, driving the throttle pause length. */
  private throttleReports = 0
  /** Whether the pause in force came from the secondary limit, not the point budget. */
  private throttleSecondary = false
  /** Budget-stretched interval the last warning named, so it is logged once per value. */
  private warnedIntervalMs = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, 'prWatcher')
    // The cordis composition loader resolves schemastery defaults before the
    // constructor; raw mounts may not, so every field keeps a fallback.
    this.pollIntervalMs = config.pollIntervalMs ?? 60000
    this.maxPointsPerHour = config.maxPointsPerHour ?? 2400
    this.ghPath = config.ghPath ?? 'gh'
    this.ghTimeoutMs = config.ghTimeoutMs ?? 30000
    this.delivery = config.delivery ?? 'steer'
    this.allowResume = config.allowResume ?? true
    this.ignoreOwnComments = config.ignoreOwnComments ?? true
    this.ignoreCommentAuthors = config.ignoreCommentAuthors ?? []
    this.stateFile = config.stateFile ?? ''
    const seen = new Set<string>()
    for (const watch of config.watches ?? []) {
      if (watch.id === '') {
        throw new Error('pr-watcher: watch id must not be empty')
      }
      if (seen.has(watch.id)) {
        throw new Error(`pr-watcher: duplicate watch id "${watch.id}"`)
      }
      seen.add(watch.id)
      parseRepo(watch.repo)
      let target: { number: number } | { branch: string }
      try {
        target = resolveTarget(watch.number, watch.branch)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`pr-watcher: watch "${watch.id}" invalid: ${message}`)
      }
      const conditions = watch.conditions ?? ('number' in target ? [...DEFAULT_CONDITIONS] : [])
      this.assertConditions(conditions)
      if ('branch' in target && conditions.length > 0) {
        throw new Error(`pr-watcher: watch "${watch.id}" is a branch watch; branch watches take no conditions`)
      }
      if ('branch' in target && watch.notifyChanges === false) {
        throw new Error(`pr-watcher: watch "${watch.id}" is a branch watch; branch watches must keep change notifications on`)
      }
      const ownSessionId = watch.sessionId ?? ''
      const sessionId = ownSessionId !== '' ? ownSessionId : (config.notifySessionId ?? '')
      if (sessionId === '') {
        throw new Error(
          `pr-watcher: watch "${watch.id}" has no notification target; set watch.sessionId or config.notifySessionId`,
        )
      }
      this.watches.set(watch.id, this.initialState({
        id: watch.id,
        repo: watch.repo,
        ...target,
        conditions,
        notifyChanges: watch.notifyChanges ?? true,
        ...(watch.ignoreOwnComments === undefined ? {} : { ignoreOwnComments: watch.ignoreOwnComments }),
        target: {
          sessionId,
          ...(watch.delivery === undefined ? {} : { delivery: watch.delivery }),
        },
      }))
    }
    if (this.stateFile !== '') {
      this.loadPersisted(seen)
    }
    // Poll loop: chain the next cycle behind each finished one so cycles never
    // overlap, and drop a tick that fires while a cycle is still running.
    ctx.effect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let inFlight = false
      const schedule = (): void => {
        const interval = this.effectiveIntervalMs()
        if (interval > this.pollIntervalMs && interval !== this.warnedIntervalMs) {
          this.warnedIntervalMs = interval
          this.ctx.logger.warn(`pr-watcher: ${this.watches.size} watches on ${this.distinctTargets()} targets exceed`
            + ` maxPointsPerHour=${this.maxPointsPerHour}; polling every ${Math.round(interval / 1000)}s`
            + ` instead of ${Math.round(this.pollIntervalMs / 1000)}s`)
        }
        timer = setTimeout(() => { void run() }, interval)
      }
      const run = async (): Promise<void> => {
        if (inFlight) return
        inFlight = true
        try {
          await this.pollAll()
        } catch (error) {
          this.ctx.logger.warn(`pr-watcher: poll cycle failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          inFlight = false
          schedule()
        }
      }
      schedule()
      return () => {
        if (timer !== undefined) clearTimeout(timer)
      }
    }, 'pr-watcher: poll loop')
  }

  private initialState(spec: WatchSpec): WatchState {
    return {
      spec,
      snapshot: undefined,
      satisfied: false,
      notified: false,
      lastError: undefined,
      lastPolledAt: undefined,
      failures: 0,
      nextAttemptAt: 0,
    }
  }

  /** Load persisted runtime watches, validating each like `watch()`. */
  private loadPersisted(seen: Set<string>): void {
    if (!existsSync(this.stateFile)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { version?: number; watches?: WatchSpec[] }
    } catch (error) {
      throw new Error(`pr-watcher: cannot read state file ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const record = parsed as { version?: number; watches?: unknown[] }
    if (record.version !== PERSIST_VERSION || !Array.isArray(record.watches)) {
      throw new Error(`pr-watcher: state file ${this.stateFile} has unsupported format (expected version ${PERSIST_VERSION})`)
    }
    for (const raw of record.watches) {
      const spec = this.validateSpec(raw)
      if (seen.has(spec.id)) {
        throw new Error(`pr-watcher: persisted watch id "${spec.id}" collides with a configured watch`)
      }
      seen.add(spec.id)
      this.watches.set(spec.id, this.initialState(spec))
    }
  }

  /** Validate an untrusted watch record (persisted file), throwing with context. */
  private validateSpec(raw: unknown): WatchSpec {
    const record = raw as Partial<WatchSpec>
    const id = typeof record.id === 'string' ? record.id : ''
    if (id === '') throw new Error('pr-watcher: persisted watch has no id')
    const repo = typeof record.repo === 'string' ? record.repo : ''
    const number = typeof record.number === 'number' ? record.number : undefined
    const branch = typeof record.branch === 'string' ? record.branch : undefined
    const targetSessionId = typeof record.target?.sessionId === 'string' ? record.target.sessionId : ''
    const delivery = typeof record.target?.delivery === 'string' ? record.target.delivery as DeliveryMode : undefined
    let target: { number: number } | { branch: string }
    let conditions: string[]
    try {
      parseRepo(repo)
      target = resolveTarget(number, branch)
      if (targetSessionId === '') throw new Error('notification sessionId must not be empty')
      conditions = ((record.conditions as string[] | undefined) ?? [])
      this.assertConditions(conditions)
      if ('branch' in target && conditions.length > 0) {
        throw new Error('branch watches take no conditions')
      }
      if ('branch' in target && record.notifyChanges !== true) {
        throw new Error('a branch watch must keep change notifications on')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`pr-watcher: persisted watch "${id}" invalid: ${message}`)
    }
    return {
      id,
      repo,
      ...target,
      conditions: conditions as ConditionName[],
      notifyChanges: record.notifyChanges === true,
      ...(typeof record.ignoreOwnComments === 'boolean' ? { ignoreOwnComments: record.ignoreOwnComments } : {}),
      target: {
        sessionId: targetSessionId,
        ...(delivery === undefined ? {} : { delivery }),
      },
    }
  }

  /** Persist the current runtime watches (config watches included) atomically. */
  private persist(): void {
    if (this.stateFile === '') return
    const payload = {
      version: PERSIST_VERSION,
      watches: [...this.watches.values()].map((state) => ({
        id: state.spec.id,
        repo: state.spec.repo,
        ...(state.spec.number === undefined ? { branch: state.spec.branch } : { number: state.spec.number }),
        conditions: [...state.spec.conditions],
        notifyChanges: state.spec.notifyChanges,
        ...(state.spec.ignoreOwnComments === undefined ? {} : { ignoreOwnComments: state.spec.ignoreOwnComments }),
        target: {
          sessionId: state.spec.target.sessionId,
          ...(state.spec.target.delivery === undefined ? {} : { delivery: state.spec.target.delivery }),
        },
      })),
    }
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.stateFile)
    } catch (error) {
      this.ctx.logger.warn(`pr-watcher: cannot persist watches to ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private assertConditions(conditions: readonly string[]): asserts conditions is readonly ConditionName[] {
    if (conditions.includes('merged') && conditions.includes('closed')) {
      throw new Error('pr-watcher: conditions cannot include both merged and closed')
    }
    if (conditions.includes('checksPassed') && conditions.includes('checksFailed')) {
      throw new Error('pr-watcher: conditions cannot include both checksPassed and checksFailed')
    }
    if (conditions.includes('mergeable') && conditions.includes('conflicted')) {
      throw new Error('pr-watcher: conditions cannot include both mergeable and conflicted')
    }
    for (const name of conditions) {
      if (!isConditionName(name)) {
        throw new Error(`pr-watcher: unknown condition "${name}"`)
      }
    }
  }

  /**
   * One-shot status query for a PR, without registering a watch.
   * @param repo - repository as `owner/name`.
   * @param number - pull request number.
   * @returns the snapshot, or a structured failure reason.
   */
  async check(repo: string, number: number): Promise<QueryResult> {
    try {
      const snapshot = await this.fetchSnapshot({ repo, number })
      return { ok: true, snapshot }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * One-shot status query for a branch head, without registering a watch.
   * @param repo - repository as `owner/name`.
   * @param branch - branch name, e.g. `master`.
   * @returns the snapshot, or a structured failure reason.
   */
  async checkBranch(repo: string, branch: string): Promise<QueryResult> {
    try {
      const snapshot = await this.fetchSnapshot({ repo, branch })
      return { ok: true, snapshot }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Register a runtime watch (typically from the model-facing `pr_watch` tool).
   * @param spec - the watch to register.
   * @returns the registered id, or a structured failure reason.
   */
  watch(spec: WatchSpec): WatchResult {
    if (spec.id === '') return { ok: false, reason: 'watch id must not be empty' }
    if (this.watches.has(spec.id)) return { ok: false, reason: `watch "${spec.id}" already registered` }
    const failure = this.specFailure(spec)
    if (failure !== undefined) return { ok: false, reason: failure }
    this.watches.set(spec.id, this.initialState(spec))
    this.persist()
    return { ok: true, id: spec.id }
  }

  /** Validate one watch spec, returning a failure reason or undefined. */
  private specFailure(spec: WatchSpec): string | undefined {
    if (spec.target.sessionId === '') return 'notification sessionId must not be empty'
    let target: { number: number } | { branch: string }
    try {
      target = resolveTarget(spec.number, spec.branch)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    if ('branch' in target && spec.conditions.length > 0) {
      return 'branch watches take no conditions; they notify on every head advance'
    }
    if ('branch' in target && !spec.notifyChanges) {
      return 'a branch watch must keep change notifications on; it has no conditions to satisfy'
    }
    try {
      parseRepo(spec.repo)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    try {
      this.assertConditions(spec.conditions)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return undefined
  }

  /**
   * Remove a watch.
   * @param id - the watch id.
   * @returns whether a watch with that id existed and was removed.
   */
  unwatch(id: string): boolean {
    const removed = this.watches.delete(id)
    if (removed) this.persist()
    return removed
  }

  /** Live view of every registered watch. */
  list(): WatchStatus[] {
    return [...this.watches.values()].map((state) => ({
      id: state.spec.id,
      repo: state.spec.repo,
      ...(state.spec.number === undefined ? { branch: state.spec.branch } : { number: state.spec.number }),
      conditions: state.spec.conditions,
      notifyChanges: state.spec.notifyChanges,
      ignoreOwnComments: state.spec.ignoreOwnComments ?? this.ignoreOwnComments,
      target: state.spec.target,
      satisfied: state.satisfied,
      notified: state.notified,
      snapshot: state.snapshot,
      lastError: state.lastError,
      lastPolledAt: state.lastPolledAt,
    }))
  }

  /**
   * Fetch one status snapshot. The GraphQL round-trip carries the counts; for
   * a PR the conversation window is fetched over REST only when no previous
   * snapshot exists or the conversation counts moved, so quiet polls never pay
   * for the extra calls. A conversation fetch failure keeps the previous
   * window (or an empty one) instead of failing the poll.
   * @param spec - the watched PR or branch.
   * @param prev - the previous snapshot, when polling an existing watch.
   */
  protected async fetchSnapshot(
    spec: { repo: string; number: number } | { repo: string; branch: string },
    prev?: WatchSnapshot,
  ): Promise<WatchSnapshot> {
    if ('branch' in spec) return this.fetchBranchBase(spec)
    const base = await this.fetchBase(spec)
    let conversation: readonly ConversationEntry[]
    if (prev !== undefined && prev.kind === 'pr' && !conversationCountsChanged(prev, base)) {
      conversation = prev.conversation
    } else {
      try {
        conversation = await this.fetchConversationWindow(spec)
      } catch (error) {
        this.ctx.logger.warn(
          `pr-watcher: conversation fetch failed for ${spec.repo}#${spec.number}: ${error instanceof Error ? error.message : String(error)}`,
        )
        conversation = prev?.kind === 'pr' ? prev.conversation : []
      }
    }
    return { ...base, conversation }
  }

  /** GraphQL half of a snapshot: counts plus state, without conversation content. */
  protected async fetchBase(spec: { repo: string; number: number }): Promise<PrSnapshot> {
    const { owner, name } = parseRepo(spec.repo)
    const data = await ghGraphql(
      this.ghPath,
      PR_QUERY,
      { owner, name, number: String(spec.number) },
      this.ghTimeoutMs,
    )
    return snapshotFromGraphql(spec.repo, spec.number, data)
  }

  /** REST half of a snapshot: the newest conversation window. */
  protected async fetchConversationWindow(spec: { repo: string; number: number }): Promise<ConversationEntry[]> {
    return fetchConversation(this.ghPath, spec.repo, spec.number, this.ghTimeoutMs)
  }

  /** GraphQL half of a branch watch's snapshot: the branch head commit. */
  protected async fetchBranchBase(spec: { repo: string; branch: string }): Promise<BranchSnapshot> {
    return fetchBranchSnapshot(this.ghPath, spec.repo, spec.branch, this.ghTimeoutMs)
  }

  /**
   * Login of the account `gh` is authenticated as, resolved at most once per
   * process. A failure returns undefined and is retried on the next poll, so a
   * transient gh outage does not disable comment filtering for the process.
   * @returns the login, or undefined when gh cannot report it.
   */
  protected async resolveSelfLogin(): Promise<string | undefined> {
    if (this.selfLoginResolved) return this.selfLogin
    try {
      this.selfLogin = await fetchAuthenticatedLogin(this.ghPath, this.ghTimeoutMs)
      this.selfLoginResolved = true
    } catch (error) {
      if (!this.selfLoginWarned) {
        this.selfLoginWarned = true
        this.ctx.logger.warn('pr-watcher: cannot resolve the authenticated gh login, so own-comment'
          + ` filtering is inactive: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.selfLogin
  }

  /**
   * Logins whose comments never count as a change for this watch: the
   * configured list, plus the authenticated account when the watch filters its
   * own comments (the service default, overridable per watch).
   * @param spec - the watch being polled.
   * @returns lowercased logins to filter; empty disables filtering.
   */
  protected async commentAuthorFilter(spec: WatchSpec): Promise<readonly string[]> {
    const authors = this.ignoreCommentAuthors.map((author) => author.toLowerCase())
    if (spec.ignoreOwnComments ?? this.ignoreOwnComments) {
      const login = await this.resolveSelfLogin()
      if (login !== undefined) authors.push(login.toLowerCase())
    }
    return authors
  }

  /** Current epoch milliseconds; the throttle window is read through this seam. */
  protected now(): number {
    return Date.now()
  }

  /** Wait `ms` between two watch polls; tests run without the pacing wait. */
  protected async pace(ms: number): Promise<void> {
    await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
  }

  /** Number of distinct fetch targets across the registered watches. */
  private distinctTargets(): number {
    return new Set([...this.watches.values()].map((state) => targetKey(specTarget(state.spec)))).size
  }

  /**
   * Delay before the next poll cycle. `pollIntervalMs` is the floor; the
   * configured point budget stretches it when the watched targets would cost
   * more GraphQL points per hour than this service may spend, because that
   * budget is shared with every other client on the same account.
   * @returns the delay in milliseconds.
   */
  protected effectiveIntervalMs(): number {
    if (this.maxPointsPerHour <= 0) return this.pollIntervalMs
    // One query per target per cycle, and one point per query.
    const budgetInterval = Math.ceil((this.distinctTargets() * 3_600_000) / this.maxPointsPerHour)
    return Math.max(this.pollIntervalMs, budgetInterval)
  }

  /**
   * Poll every registered watch once. Watches that target the same pull request
   * or branch head share one fetch per cycle: a snapshot belongs to the target,
   * not to the watch, so N watches on one PR must not cost N GitHub requests.
   * Groups are spaced by a short pacing delay so one cycle never issues every
   * request at the same moment: a burst of requests is what trips GitHub's
   * secondary rate limit. A rate limit pauses the whole service (see
   * {@link PrWatcherService.noteThrottle}), so the cycle stops instead of
   * spending the remaining groups on calls that cannot succeed.
   */
  private async pollAll(): Promise<void> {
    if (this.throttled()) return
    const groups = new Map<string, WatchState[]>()
    for (const state of this.watches.values()) {
      if (this.now() < state.nextAttemptAt) continue
      const key = targetKey(specTarget(state.spec))
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [state])
      else group.push(state)
    }
    const paceMs = groups.size > 1
      ? Math.max(0, Math.min(POLL_PACING_MS, Math.floor(this.pollIntervalMs / groups.size)))
      : 0
    let index = 0
    for (const group of groups.values()) {
      if (this.throttled()) return
      if (index > 0 && paceMs > 0) await this.pace(paceMs)
      index += 1
      await this.pollGroup(group)
    }
  }

  /**
   * Fetch one target once and apply the result to every watch on it. A fetch
   * failure marks each member watch with that failure and its own backoff
   * window, so one unreachable target does not stop the other groups.
   * @param group - the watches sharing this target; never empty.
   */
  private async pollGroup(group: WatchState[]): Promise<void> {
    const first = group[0]
    if (first === undefined || this.throttled()) return
    // A member without a snapshot needs the conversation window, so the shared
    // fetch must not satisfy itself from another member's stored window. A
    // member whose stored window is older than the one used here (a watch that
    // was backing off while its target was polled) still sees the count change;
    // it reports that change without an embedded comment body for one cycle.
    const prev = group.some((state) => state.snapshot === undefined) ? undefined : first.snapshot
    let snapshot: WatchSnapshot
    try {
      snapshot = await this.fetchSnapshot(specTarget(first.spec), prev)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const state of group) {
        state.failures += 1
        state.nextAttemptAt = this.now() + backoffDelay(state.failures)
        state.lastError = message
        state.lastPolledAt = new Date().toISOString()
      }
      if (isRateLimitMessage(message)) {
        this.noteThrottle(message)
        return
      }
      this.ctx.logger.warn(`pr-watcher: target "${targetKey(specTarget(first.spec))}" fetch failed: ${message}`
        + ` (backing off ${backoffDelay(first.failures) / 1000}s)`)
      return
    }
    for (const state of group) await this.applySnapshot(state, snapshot)
  }

  /** Whether the service is inside a rate-limit pause. */
  private throttled(): boolean {
    return this.now() < this.throttleUntil
  }

  /**
   * Record one GitHub rate-limit report and pause every watch. Pausing the
   * service, rather than only the failing watch, is what lets the account
   * recover: retrying the other watches into a throttled account keeps the
   * throttle hot and delays the reset. The pause schedule follows what was
   * reported: an exhausted point budget refills on its hourly window, while the
   * secondary (abuse-detection) limit clears in minutes, so each escalates from
   * its own base to its own ceiling.
   * @param message - the failure text; selects the pause schedule and is logged.
   */
  private noteThrottle(message: string): void {
    const secondary = isSecondaryRateLimitMessage(message)
    if (secondary !== this.throttleSecondary) {
      this.throttleSecondary = secondary
      this.throttleReports = 0
    }
    this.throttleReports += 1
    const base = secondary ? THROTTLE_SECONDARY_BASE_MS : THROTTLE_BASE_MS
    const ceiling = secondary ? THROTTLE_SECONDARY_MAX_MS : THROTTLE_MAX_MS
    const pause = Math.min(ceiling, base * 2 ** (this.throttleReports - 1))
    const first = !this.throttled()
    this.throttleUntil = this.now() + pause
    if (first) {
      this.ctx.logger.warn(`pr-watcher: GitHub ${secondary ? 'secondary ' : ''}rate limit reported (${message});`
        + ` pausing every watch for ${Math.round(pause / 1000)}s`)
    }
  }

  /**
   * Apply one fetched snapshot to a watch: refresh its state, then deliver the
   * notification its edges call for. The snapshot may be shared with every
   * other watch on the same target.
   * @param state - the watch to update.
   * @param fetched - the snapshot fetched for its target.
   */
  private async applySnapshot(state: WatchState, fetched: WatchSnapshot): Promise<void> {
    const prev = state.snapshot
    state.failures = 0
    state.nextAttemptAt = 0
    this.throttleReports = 0
    this.throttleUntil = 0
    const snapshot = carryForwardMergeable(fetched, prev)
    state.snapshot = snapshot
    state.lastError = undefined
    state.lastPolledAt = new Date().toISOString()

    // Branch watches carry no conditions, so they only ever produce change
    // notifications and never a satisfied edge.
    const satisfied = snapshot.kind === 'pr'
      && conditionsMet(state.spec.conditions, evaluateConditions(snapshot))
    // The satisfied notification is a one-shot: a watch that already delivered
    // it stays silent even if a condition later falls out of hold and returns
    // (a check rerun, a queued mergeability recompute), which would otherwise
    // deliver the same "conditions met" message again.
    const satisfiedEdge = satisfied && !state.satisfied && !state.notified
    state.satisfied = satisfied
    if (satisfiedEdge) state.notified = true

    const raw = prev === undefined ? null : diffSnapshots(prev, snapshot)
    // Comments from filtered authors (by default the authenticated gh account,
    // which this session itself posts through) are noise: they are dropped from
    // the summary and from the count deltas they account for, so a poll whose
    // only news is such a comment reports no change at all.
    const filtered = raw !== null && raw.kind === 'pr'
      ? filterCommentAuthors(raw, await this.commentAuthorFilter(state.spec))
      : { change: raw, ignoredComments: 0 }
    const change = filtered.change
    const changed = hasChanges(change)

    // A satisfied watch is done: after the single edge notification it stays
    // silent even when later changes arrive; a change-only watch (never
    // satisfied) keeps notifying as long as notifyChanges is on.
    if (!satisfiedEdge && !(state.spec.notifyChanges && changed && !state.notified)) return
    const text = buildNotificationText(
      state.spec.id,
      snapshot,
      satisfied,
      satisfiedEdge,
      change,
      filtered.ignoredComments,
    )
    const delivered = await this.deliver(state.spec.target, text)
    if (!delivered.delivered) {
      this.ctx.logger.warn(`pr-watcher: watch "${state.spec.id}" notification not delivered: ${delivered.reason}`)
    }
    this.ctx.emit('pr-watcher/notify', {
      id: state.spec.id,
      repo: state.spec.repo,
      ...(state.spec.number === undefined ? { branch: state.spec.branch } : { number: state.spec.number }),
      satisfied: satisfiedEdge,
      changed: satisfiedEdge ? change : (changed ? change : null),
      ignoredComments: filtered.ignoredComments,
      delivered: delivered.delivered,
      text,
    })
  }

  /**
   * Deliver one message into a target agent's inbox, waking a persisted
   * session only when configured and possible. The subagent-ownership fence
   * matches the Host's handoff paths.
   */
  private async deliver(
    target: { sessionId: string; delivery?: DeliveryMode },
    text: string,
  ): Promise<DeliveryResult> {
    let agent = this.ctx.agents.get(target.sessionId as Agent['id'])
    if (agent === undefined) {
      if (!this.allowResume) return { delivered: false, reason: 'session-not-live' }
      const lookup = this.ctx.get('typert')?.lookups.get('agent')
      if (lookup === undefined) return { delivered: false, reason: 'session-not-live' }
      try {
        const resolved = await lookup.resolve(target.sessionId as never)
        if (resolved === undefined || resolved === null) return { delivered: false, reason: 'session-not-live' }
        agent = resolved as Agent
      } catch {
        return { delivered: false, reason: 'resume-failed' }
      }
    }
    if (isSessionOwnedBySubagent(this.ctx, agent.session, agent)) {
      return { delivered: false, reason: 'session-owned-by-subagent' }
    }
    const message = createUserMessage({
      source: {
        kind: 'plugin:dsh-pr-watcher',
        form: 'notice',
        summary: boundContextSummary('PR watch notification'),
      },
      content: [{ type: 'text', text }],
    })
    const mode: DeliveryMode = target.delivery ?? this.delivery
    switch (mode) {
      case 'steer':
        agent.steer(message)
        break
      case 'inject':
        agent.inject(message)
        break
      case 'followup':
        agent.followup(message)
        break
    }
    return { delivered: true }
  }
}

export default PrWatcherService
