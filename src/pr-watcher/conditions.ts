/**
 * Condition evaluation and change detection for `dsh-pr-watcher`, plus the
 * notification text builder. Pure functions: no I/O, unit-testable directly.
 * @module dsh-pr-watcher
 */

import type { ChangeSummary, ConditionName, ConditionResult, PrSnapshot } from './types.ts'

export { hasChanges } from './types.ts'

/**
 * Evaluate every condition against one snapshot.
 *
 * - `checksPassed` — no failed and no pending checks (`non-pass=0`, fully
 *   settled). A PR with no checks at all reports 0/0/0/0 and satisfies
 *   vacuously; the notification text shows the counts so the receiver can see
 *   that the PR carries no checks.
 * - `threadsResolved` — no unresolved review threads.
 * - `mergeable` — GitHub reports `MERGEABLE`.
 * - `reviewApproved` — review decision is `APPROVED`.
 * - `merged` — PR state is `MERGED`.
 * - `closed` — PR state is `CLOSED` (GitHub's CLOSED never overlaps MERGED).
 */
export function evaluateConditions(snapshot: PrSnapshot): ConditionResult {
  return {
    checksPassed: snapshot.checks.failed === 0 && snapshot.checks.pending === 0,
    threadsResolved: snapshot.unresolvedThreads === 0,
    mergeable: snapshot.mergeable === 'MERGEABLE',
    reviewApproved: snapshot.reviewDecision === 'APPROVED',
    merged: snapshot.state === 'MERGED',
    closed: snapshot.state === 'CLOSED',
  }
}

/**
 * Whether a watch's selected conditions are all met.
 * @param conditions - the watch's selection; empty never satisfies.
 * @param result - condition truth values for the current snapshot.
 */
export function conditionsMet(conditions: readonly ConditionName[], result: ConditionResult): boolean {
  return conditions.length > 0 && conditions.every((name) => result[name])
}

/**
 * Diff two consecutive snapshots of the same PR.
 * @param prev - the earlier snapshot.
 * @param next - the later snapshot.
 * @returns the deltas; null fields mean unchanged, counts are positive deltas.
 */
export function diffSnapshots(prev: PrSnapshot, next: PrSnapshot): ChangeSummary {
  return {
    headRefOid: prev.headRefOid !== next.headRefOid ? next.headRefOid : null,
    headRefName: prev.headRefName !== next.headRefName ? next.headRefName : null,
    commits: Math.max(0, next.commits - prev.commits),
    reviews: Math.max(0, next.reviews - prev.reviews),
    reviewThreads: Math.max(0, next.reviewThreads - prev.reviewThreads),
    reviewComments: Math.max(0, next.reviewComments - prev.reviewComments),
    issueComments: Math.max(0, next.issueComments - prev.issueComments),
  }
}

function shortOid(oid: string): string {
  return oid.length > 8 ? oid.slice(0, 8) : oid
}

/** Render a `ChangeSummary` as a compact `changes:` line, empty when nothing changed. */
export function renderChanges(change: ChangeSummary): string {
  const parts: string[] = []
  if (change.headRefOid !== null) {
    parts.push(`head moved to ${shortOid(change.headRefOid)}`)
  }
  if (change.commits > 0) parts.push(`+${change.commits} commit${change.commits === 1 ? '' : 's'}`)
  if (change.reviews > 0) parts.push(`+${change.reviews} review${change.reviews === 1 ? '' : 's'}`)
  if (change.reviewThreads > 0) parts.push(`+${change.reviewThreads} review thread${change.reviewThreads === 1 ? '' : 's'}`)
  if (change.reviewComments > 0) parts.push(`+${change.reviewComments} review comment${change.reviewComments === 1 ? '' : 's'}`)
  if (change.issueComments > 0) parts.push(`+${change.issueComments} issue comment${change.issueComments === 1 ? '' : 's'}`)
  return parts.length === 0 ? '' : `changes: ${parts.join(', ')}`
}

/**
 * Build the notification text for a watch.
 * @param id - the watch id.
 * @param snapshot - the current snapshot.
 * @param satisfied - whether the selected conditions are currently met.
 * @param satisfiedEdge - whether this poll flipped the watch into satisfied.
 * @param change - the diff vs the previous poll, or null for the first poll.
 * @returns the message text delivered to the target session.
 */
export function buildNotificationText(
  id: string,
  snapshot: PrSnapshot,
  satisfied: boolean,
  satisfiedEdge: boolean,
  change: ChangeSummary | null,
): string {
  const lines: string[] = []
  if (satisfiedEdge) {
    lines.push(`PR watch "${id}" conditions met: ${snapshot.repo}#${snapshot.number} (${snapshot.url})`)
  } else {
    lines.push(`PR watch "${id}" changed: ${snapshot.repo}#${snapshot.number} (${snapshot.url})`)
  }
  const stateLine = snapshot.state === 'MERGED' ? 'state: MERGED' : `state: ${snapshot.state}`
  lines.push(stateLine)
  lines.push(`checks: ${snapshot.checks.failed} failed, ${snapshot.checks.pending} pending of ${snapshot.checks.total}`)
  lines.push(`review threads: ${snapshot.unresolvedThreads} unresolved of ${snapshot.reviewThreads}`)
  if (snapshot.mergeable !== null) lines.push(`mergeable: ${snapshot.mergeable}`)
  if (snapshot.reviewDecision !== null) lines.push(`review decision: ${snapshot.reviewDecision}`)
  if (change !== null) {
    const changesLine = renderChanges(change)
    if (changesLine !== '') lines.push(changesLine)
  }
  if (satisfiedEdge) {
    lines.push('watch satisfied; notifications for this watch stop here')
  }
  return lines.join('\n')
}
