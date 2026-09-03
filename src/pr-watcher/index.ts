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
  buildNotificationText,
  conditionsMet,
  diffSnapshots,
  evaluateConditions,
} from './conditions.ts'
import { ghGraphql, parseRepo, PR_QUERY, snapshotFromGraphql } from './gh.ts'
import {
  DEFAULT_CONDITIONS,
  hasChanges,
  isConditionName,
  type ConditionName,
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
  /** Default delivery mode for notifications. */
  delivery: deliverySchema.default('inject'),
  /** Whether a notification may wake a persisted (not live) session. */
  allowResume: z.boolean().default(false),
  /** Default target session for static watches that omit their own sessionId. */
  notifySessionId: z.string().default(''),
  /** Static watches validated at load. */
  watches: z.array(configWatchSchema).default([]),
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

  constructor(ctx: Context, config: Config) {
    super(ctx, 'prWatcher')
    // The cordis composition loader resolves schemastery defaults before the
    // constructor; raw mounts may not, so every field keeps a fallback.
    this.pollIntervalMs = config.pollIntervalMs ?? 60000
    this.ghPath = config.ghPath ?? 'gh'
    this.ghTimeoutMs = config.ghTimeoutMs ?? 30000
    this.delivery = config.delivery ?? 'inject'
    this.allowResume = config.allowResume ?? false
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
    if (spec.target.sessionId === '') return { ok: false, reason: 'notification sessionId must not be empty' }
    if (!Number.isInteger(spec.number) || spec.number < 1) {
      return { ok: false, reason: `invalid pull request number ${spec.number}` }
    }
    try {
      parseRepo(spec.repo)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    try {
      this.assertConditions(spec.conditions)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    this.watches.set(spec.id, this.initialState(spec))
    return { ok: true, id: spec.id }
  }

  /**
   * Remove a watch.
   * @param id - the watch id.
   * @returns whether a watch with that id existed and was removed.
   */
  unwatch(id: string): boolean {
    return this.watches.delete(id)
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

  protected async fetchSnapshot(spec: { repo: string; number: number }): Promise<PrSnapshot> {
    const { owner, name } = parseRepo(spec.repo)
    const data = await ghGraphql(
      this.ghPath,
      PR_QUERY,
      { owner, name, number: String(spec.number) },
      this.ghTimeoutMs,
    )
    return snapshotFromGraphql(spec.repo, spec.number, data)
  }

  /** Poll every registered watch once. */
  private async pollAll(): Promise<void> {
    for (const state of this.watches.values()) {
      await this.pollWatch(state)
    }
  }

  /** Poll one watch: refresh the snapshot and handle notification edges. */
  private async pollWatch(state: WatchState): Promise<void> {
    let snapshot: PrSnapshot
    try {
      snapshot = await this.fetchSnapshot(state.spec)
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
      state.lastPolledAt = new Date().toISOString()
      this.ctx.logger.warn(`pr-watcher: watch "${state.spec.id}" fetch failed: ${state.lastError}`)
      return
    }
    const prev = state.snapshot
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

    if (!satisfiedEdge && !(state.spec.notifyChanges && changed)) return
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
