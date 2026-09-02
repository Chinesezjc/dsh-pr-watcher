/**
 * Shared contracts for `dsh-pr-watcher`: watch configuration, the PR status
 * snapshot produced from one GitHub GraphQL query, condition evaluation, and
 * the results surfaced to the model-facing tools.
 * @module dsh-pr-watcher
 */

/**
 * The evaluable conditions a watch can gate on. `satisfied` is the AND of the
 * conditions a watch selects. An empty selection never satisfies (change-only
 * watch).
 */
export const CONDITION_NAMES = [
  'checksPassed',
  'checksFailed',
  'threadsResolved',
  'mergeable',
  'reviewApproved',
  'merged',
  'closed',
] as const
export type ConditionName = (typeof CONDITION_NAMES)[number]

export function isConditionName(value: string): value is ConditionName {
  return (CONDITION_NAMES as readonly string[]).includes(value)
}

/**
 * The default condition selection for new watches: the "ready" set, without
 * the terminal states and without the CI-failure trigger.
 */
export const DEFAULT_CONDITIONS: readonly ConditionName[] = [
  'checksPassed',
  'threadsResolved',
  'mergeable',
  'reviewApproved',
]

/**
 * How one notification reaches the target agent's inbox. Each value names an
 * existing `Agent` method, which is exactly the pair `(inbox target, wakeup)`:
 * - `followup` — `next-turn` + wake: the message becomes its own turn, queued
 *   behind whatever the agent is currently doing.
 * - `steer` — `next-step` + wake: the message cuts into the nearest step
 *   boundary of a running turn instead of waiting for that turn to finish; an
 *   idle agent starts a turn.
 * - `inject` — `next-step`, no wake: seeds model-facing context without waking
 *   an idle agent, so it can sit unread until something else wakes it.
 */
export type DeliveryMode = 'followup' | 'steer' | 'inject'

/** Destination of one watch's notifications. */
export interface WatchTarget {
  /** Session id that receives the notification messages. */
  readonly sessionId: string
  /** Per-watch delivery mode override; absent uses the service default. */
  readonly delivery?: DeliveryMode
}

/**
 * One watched pull request. `repo` is always `owner/name` supplied by the
 * caller; no repository name is baked into the plugin.
 */
export interface WatchSpec {
  /** Stable id used to register, list, and remove the watch. */
  readonly id: string
  /** Repository as `owner/name`, e.g. `<owner>/<repo>`. */
  readonly repo: string
  /** Pull request number within the repository. */
  readonly number: number
  /** Conditions ANDed for the satisfied notification; empty never satisfies. */
  readonly conditions: readonly ConditionName[]
  /** Notify on observed changes even before the conditions are satisfied. */
  readonly notifyChanges: boolean
  readonly target: WatchTarget
}

/** Rolled-up CI check counts from the PR's status check rollup. */
export interface CheckSummary {
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly pending: number
}

/**
 * One observed PR state. `checks.failed` counts only bad conclusions/states
 * (FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE,
 * STALE); `checks.pending` counts not-yet-settled runs (QUEUED, IN_PROGRESS,
 * REQUESTED, WAITING, PENDING, EXPECTED, or a null conclusion). A PR with no
 * checks reports 0/0/0/0. `failedChecks` names the failing runs (CheckRun
 * `name` / StatusContext `context`) in rollup order.
 */
export interface PrSnapshot {
  readonly repo: string
  readonly number: number
  readonly url: string
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED'
  readonly merged: boolean
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | 'BLOCKED' | 'BEHIND' | null
  readonly reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  readonly headRefName: string
  readonly headRefOid: string
  readonly commits: number
  readonly reviews: number
  readonly reviewThreads: number
  readonly reviewComments: number
  readonly issueComments: number
  readonly unresolvedThreads: number
  readonly checks: CheckSummary
  readonly failedChecks: readonly string[]
}

/** Truth value of every evaluable condition for one snapshot. */
export type ConditionResult = Record<ConditionName, boolean>

/**
 * What changed between two consecutive snapshots of the same PR. A null field
 * means "unchanged"; a count is the signed delta (negative means decreased).
 * `checks` carries the signed per-state check deltas, so check-run transitions
 * (pending → failed / passed) surface as change notifications.
 */
export interface ChangeSummary {
  /** New head commit oid when the head ref moved. */
  readonly headRefOid: string | null
  /** New head branch name when the head ref moved. */
  readonly headRefName: string | null
  readonly commits: number
  readonly reviews: number
  readonly reviewThreads: number
  readonly reviewComments: number
  readonly issueComments: number
  /** Signed per-state check count deltas. */
  readonly checks: {
    readonly passed: number
    readonly failed: number
    readonly pending: number
  }
  /** Check names that failed in the new snapshot but did not fail before. */
  readonly newlyFailedChecks: readonly string[]
}

/** Whether a change summary contains any observed change. */
export function hasChanges(change: ChangeSummary | null): boolean {
  return change !== null && (
    change.headRefOid !== null
    || change.commits > 0
    || change.reviews > 0
    || change.reviewThreads > 0
    || change.reviewComments > 0
    || change.issueComments > 0
    || change.checks.passed !== 0
    || change.checks.failed !== 0
    || change.checks.pending !== 0
    || change.newlyFailedChecks.length > 0
  )
}

/** Live view of one registered watch, surfaced by `pr_watch_list`. */
export interface WatchStatus {
  readonly id: string
  readonly repo: string
  readonly number: number
  readonly conditions: readonly ConditionName[]
  readonly notifyChanges: boolean
  readonly target: WatchTarget
  /** Whether the conditions currently hold. */
  readonly satisfied: boolean
  /** Whether the satisfied notification was already delivered (edge-triggered). */
  readonly notified: boolean
  readonly snapshot: PrSnapshot | undefined
  readonly lastError: string | undefined
  readonly lastPolledAt: string | undefined
}

export type WatchResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: string }

export type QueryResult =
  | { readonly ok: true; readonly snapshot: PrSnapshot }
  | { readonly ok: false; readonly reason: string }

export type DeliveryResult =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string }

/** Payload of the `pr-watcher/notify` event emitted per delivered notification. */
export interface WatchNotifyInfo {
  readonly id: string
  readonly repo: string
  readonly number: number
  /** True when the notification was the satisfied transition; false for a change notification. */
  readonly satisfied: boolean
  readonly changed: ChangeSummary | null
  readonly delivered: boolean
  readonly text: string
}
