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
} from './conditions.ts'
import {
  conversationCountsChanged,
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
  type ConditionName,
  type ConversationEntry,
  type DeliveryMode,
  type DeliveryResult,
  type PrSnapshot,
  type QueryResult,
  type WatchNotifyInfo,
  type WatchResult,
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

/** Plugin identity attached to delivered messages. */
const PLUGIN_SOURCE = 'dsh-pr-watcher'

/** One registered watch plus its runtime state. */
interface WatchState {
  readonly spec: WatchSpec
  snapshot: PrSnapshot | undefined
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

const deliverySchema = z.union([z.const('followup'), z.const('steer'), z.const('inject')])

const configWatchSchema = z.object({
  id: z.string(),
  repo: z.string(),
  number: z.natural(),
  // Condition names are validated by PrWatcherService.assertConditions at load.
  conditions: z.array(z.string()).default([...DEFAULT_CONDITIONS]),
  notifyChanges: z.boolean().default(false),
  sessionId: z.string().default(''),
  delivery: deliverySchema.required(false),
})

/** Resolved service config; the cordis loader applies schema defaults first. */
export interface Config {
  /** Interval between poll cycles; overlapping cycles are skipped, not queued. */
  readonly pollIntervalMs: number
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
  readonly number: number
  /** Condition names; validated by {@link PrWatcherService.assertConditions}. */
  readonly conditions: readonly string[]
  readonly notifyChanges: boolean
  /** Target session; empty falls back to `Config.notifySessionId`. */
  readonly sessionId: string
  readonly delivery: DeliveryMode | undefined
}

const configSchema: Schemastery = z.object({
  /** Interval between poll cycles; overlapping cycles are skipped, not queued. */
  pollIntervalMs: z.natural().min(30000).max(3_600_000).default(60000),
  /** Path or name of the `gh` executable. */
  ghPath: z.string().default('gh'),
  /** Per-`gh`-call timeout. */
  ghTimeoutMs: z.natural().min(5000).max(120_000).default(30_000),
  /** Default delivery mode for notifications; `followup` wakes an idle-loaded target. */
  delivery: deliverySchema.default('followup'),
  /** Whether a notification may wake a persisted (not live) session. */
  allowResume: z.boolean().default(true),
  /** Default target session for static watches that omit their own sessionId. */
  notifySessionId: z.string().default(''),
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
  private readonly ghPath: string
  private readonly ghTimeoutMs: number
  private readonly delivery: DeliveryMode
  private readonly allowResume: boolean
  private readonly watches = new Map<string, WatchState>()
  private readonly stateFile: string

  constructor(ctx: Context, config: Config) {
    super(ctx, 'prWatcher')
    // The cordis composition loader resolves schemastery defaults before the
    // constructor; raw mounts may not, so every field keeps a fallback.
    this.pollIntervalMs = config.pollIntervalMs ?? 60000
    this.ghPath = config.ghPath ?? 'gh'
    this.ghTimeoutMs = config.ghTimeoutMs ?? 30000
    this.delivery = config.delivery ?? 'followup'
    this.allowResume = config.allowResume ?? true
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
      const conditions = watch.conditions ?? [...DEFAULT_CONDITIONS]
      this.assertConditions(conditions)
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
        number: watch.number,
        conditions,
        notifyChanges: watch.notifyChanges ?? false,
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
        timer = setTimeout(() => { void run() }, this.pollIntervalMs)
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
    const number = typeof record.number === 'number' ? record.number : NaN
    const targetSessionId = typeof record.target?.sessionId === 'string' ? record.target.sessionId : ''
    const delivery = typeof record.target?.delivery === 'string' ? record.target.delivery as DeliveryMode : undefined
    try {
      parseRepo(repo)
      if (!Number.isInteger(number) || number < 1) throw new Error(`invalid pull request number ${number}`)
      if (targetSessionId === '') throw new Error('notification sessionId must not be empty')
      this.assertConditions(Array.isArray(record.conditions) ? record.conditions : [])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`pr-watcher: persisted watch "${id}" invalid: ${message}`)
    }
    const conditions = (record.conditions as string[]) ?? []
    this.assertConditions(conditions)
    return {
      id,
      repo,
      number,
      conditions,
      notifyChanges: record.notifyChanges === true,
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
        number: state.spec.number,
        conditions: [...state.spec.conditions],
        notifyChanges: state.spec.notifyChanges,
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
    if (!Number.isInteger(spec.number) || spec.number < 1) {
      return `invalid pull request number ${spec.number}`
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
      number: state.spec.number,
      conditions: state.spec.conditions,
      notifyChanges: state.spec.notifyChanges,
      target: state.spec.target,
      satisfied: state.satisfied,
      notified: state.notified,
      snapshot: state.snapshot,
      lastError: state.lastError,
      lastPolledAt: state.lastPolledAt,
    }))
  }

  /**
   * Fetch one PR status snapshot. The GraphQL round-trip carries the counts;
   * the conversation window is fetched over REST only when no previous
   * snapshot exists or the conversation counts moved, so quiet polls never
   * pay for the extra calls. A conversation fetch failure keeps the previous
   * window (or an empty one) instead of failing the poll.
   * @param spec - the watched PR.
   * @param prev - the previous snapshot, when polling an existing watch.
   */
  protected async fetchSnapshot(
    spec: { repo: string; number: number },
    prev?: PrSnapshot,
  ): Promise<PrSnapshot> {
    const base = await this.fetchBase(spec)
    let conversation: readonly ConversationEntry[]
    if (prev !== undefined && !conversationCountsChanged(prev, base)) {
      conversation = prev.conversation
    } else {
      try {
        conversation = await this.fetchConversationWindow(spec)
      } catch (error) {
        this.ctx.logger.warn(
          `pr-watcher: conversation fetch failed for ${spec.repo}#${spec.number}: ${error instanceof Error ? error.message : String(error)}`,
        )
        conversation = prev?.conversation ?? []
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

  /** Poll every registered watch once. */
  private async pollAll(): Promise<void> {
    for (const state of this.watches.values()) {
      await this.pollWatch(state)
    }
  }

  /** Poll one watch: refresh the snapshot and handle notification edges. */
  private async pollWatch(state: WatchState): Promise<void> {
    if (Date.now() < state.nextAttemptAt) return
    const prev = state.snapshot
    let snapshot: PrSnapshot
    try {
      snapshot = await this.fetchSnapshot(state.spec, prev)
    } catch (error) {
      state.failures += 1
      state.nextAttemptAt = Date.now() + backoffDelay(state.failures)
      state.lastError = error instanceof Error ? error.message : String(error)
      state.lastPolledAt = new Date().toISOString()
      this.ctx.logger.warn(`pr-watcher: watch "${state.spec.id}" fetch failed: ${state.lastError}`
        + ` (backing off ${backoffDelay(state.failures) / 1000}s)`)
      return
    }
    state.failures = 0
    state.nextAttemptAt = 0
    state.snapshot = snapshot
    state.lastError = undefined
    state.lastPolledAt = new Date().toISOString()

    const result = evaluateConditions(snapshot)
    const satisfied = conditionsMet(state.spec.conditions, result)
    const satisfiedEdge = satisfied && !state.satisfied
    state.satisfied = satisfied
    if (satisfiedEdge) state.notified = true

    const change = prev === undefined ? null : diffSnapshots(prev, snapshot)
    const changed = hasChanges(change)

    // A satisfied watch is done: after the single edge notification it stays
    // silent even when later changes arrive; a change-only watch (never
    // satisfied) keeps notifying as long as notifyChanges is on.
    if (!satisfiedEdge && !(state.spec.notifyChanges && changed && !state.notified)) return
    const text = buildNotificationText(state.spec.id, snapshot, satisfied, satisfiedEdge, change)
    const delivered = await this.deliver(state.spec.target, text)
    if (!delivered.delivered) {
      this.ctx.logger.warn(`pr-watcher: watch "${state.spec.id}" notification not delivered: ${delivered.reason}`)
    }
    this.ctx.emit('pr-watcher/notify', {
      id: state.spec.id,
      repo: state.spec.repo,
      number: state.spec.number,
      satisfied: satisfiedEdge,
      changed: satisfiedEdge ? change : (changed ? change : null),
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
        kind: 'plugin',
        plugin: PLUGIN_SOURCE,
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
