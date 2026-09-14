/**
 * Condition evaluation and change detection for `dsh-pr-watcher`, plus the
 * notification text builder. Pure functions: no I/O, unit-testable directly.
 * @module dsh-pr-watcher
 */

import type {
  ChangeSummary,
  CommentFilterResult,
  ConditionName,
  ConditionResult,
  ConversationEntry,
  PrChangeSummary,
  PrSnapshot,
  WatchSnapshot,
} from './types.ts'

export { hasChanges } from './types.ts'

/**
 * Evaluate every condition against one snapshot.
 *
 * - `checksPassed` — no failed and no pending checks (`non-pass=0`, fully
 *   settled). A PR with no checks at all reports 0/0/0/0 and satisfies
 *   vacuously; the notification text shows the counts so the receiver can see
 *   that the PR carries no checks. Fails closed when the check context window
 *   was truncated (more than 100 contexts), because hidden failures would
 *   otherwise read as green.
 * - `checksFailed` — at least one check failed. Mutually exclusive with
 *   `checksPassed` (a watch selecting both never satisfies and is rejected at
 *   load). Use for a "CI broke, intervene now" trigger.
 * - `threadsResolved` — no unresolved review threads. Fails closed when the
 *   thread window was truncated (more than 100 threads), because unresolved
 *   threads beyond the window would otherwise read as resolved.
 * - `mergeable` — GitHub reports `MERGEABLE`. Mutually exclusive with
 *   `conflicted` (a watch selecting both never satisfies and is rejected at
 *   load).
 * - `conflicted` — GitHub reports `CONFLICTING` (the PR needs a merge-forward
 *   against its base). Use for a stack watch that notifies the moment a member
 *   branch falls out of sync with its base.
 * - `reviewApproved` — review decision is `APPROVED`.
 * - `merged` — PR state is `MERGED`.
 * - `closed` — PR state is `CLOSED` (GitHub's CLOSED never overlaps MERGED).
 */
export function evaluateConditions(snapshot: PrSnapshot): ConditionResult {
  return {
    checksPassed: snapshot.checks.failed === 0 && snapshot.checks.pending === 0 && !snapshot.checksTruncated,
    checksFailed: snapshot.checks.failed > 0,
    threadsResolved: snapshot.unresolvedThreads === 0 && !snapshot.threadsTruncated,
    mergeable: snapshot.mergeable === 'MERGEABLE',
    conflicted: snapshot.mergeable === 'CONFLICTING',
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
 * Diff two consecutive snapshots of the same target.
 * @param prev - the earlier snapshot.
 * @param next - the later snapshot.
 * @returns the deltas; null fields mean unchanged, counts are signed deltas.
 * Returns null when the target kind changed (never happens for one watch).
 */
export function diffSnapshots(prev: WatchSnapshot, next: WatchSnapshot): ChangeSummary | null {
  if (prev.kind === 'branch' || next.kind === 'branch') {
    if (prev.kind !== 'branch' || next.kind !== 'branch') return null
    return {
      kind: 'branch',
      fromOid: prev.headOid,
      toOid: next.headOid,
      commits: next.commits - prev.commits,
      committedDate: next.committedDate,
    }
  }
  const prevFailed = new Set(prev.failedChecks)
  const prevComments = new Set(prev.conversation.map((entry) => entry.key))
  return {
    kind: 'pr',
    headRefOid: prev.headRefOid !== next.headRefOid ? next.headRefOid : null,
    headRefName: prev.headRefName !== next.headRefName ? next.headRefName : null,
    commits: Math.max(0, next.commits - prev.commits),
    reviews: Math.max(0, next.reviews - prev.reviews),
    reviewThreads: Math.max(0, next.reviewThreads - prev.reviewThreads),
    reviewComments: Math.max(0, next.reviewComments - prev.reviewComments),
    issueComments: Math.max(0, next.issueComments - prev.issueComments),
    checks: {
      passed: next.checks.passed - prev.checks.passed,
      failed: next.checks.failed - prev.checks.failed,
      pending: next.checks.pending - prev.checks.pending,
    },
    newlyFailedChecks: next.failedChecks.filter((name) => !prevFailed.has(name)),
    mergeable: prev.mergeable === next.mergeable
      ? null
      : { from: prev.mergeable, to: next.mergeable },
    newComments: next.conversation.filter((entry) => !prevComments.has(entry.key)),
  }
}

function shortOid(oid: string): string {
  return oid.length > 8 ? oid.slice(0, 8) : oid
}

/** Render a signed check delta as `+N failed` / `-1 pending`. */
function signedCount(delta: number, label: string): string {
  return delta > 0 ? `+${delta} ${label}` : `${delta} ${label}`
}

/**
 * Apply an author filter to a PR change summary. New comments authored by one
 * of `authors` are dropped from the window, and the comment-count deltas they
 * account for are reduced by the same amount (floored at zero, so a count move
 * larger than the visible window still reports the remainder). A poll whose
 * only news is a filtered comment therefore reports no change at all.
 * @param change - the summary produced by {@link diffSnapshots}.
 * @param authors - login names whose comments do not count as changes; matched
 * case-insensitively. An empty list returns the summary unchanged.
 * @returns the filtered summary plus how many comments were dropped.
 */
export function filterCommentAuthors(
  change: PrChangeSummary,
  authors: readonly string[],
): CommentFilterResult {
  if (authors.length === 0 || change.newComments.length === 0) {
    return { change, ignoredComments: 0 }
  }
  const lowered = new Set(authors.map((author) => author.toLowerCase()))
  const dropped = change.newComments.filter((entry) => lowered.has(entry.author.toLowerCase()))
  if (dropped.length === 0) return { change, ignoredComments: 0 }
  let issue = 0
  let review = 0
  let inline = 0
  for (const entry of dropped) {
    if (entry.kind === 'issue') issue += 1
    else if (entry.kind === 'review') review += 1
    else inline += 1
  }
  return {
    change: {
      ...change,
      issueComments: Math.max(0, change.issueComments - issue),
      reviews: Math.max(0, change.reviews - review),
      reviewComments: Math.max(0, change.reviewComments - inline),
      newComments: change.newComments.filter((entry) => !lowered.has(entry.author.toLowerCase())),
    },
    ignoredComments: dropped.length,
  }
}

/** Render a `ChangeSummary` as a compact `changes:` line, empty when nothing changed. */
export function renderChanges(change: ChangeSummary): string {
  if (change.kind === 'branch') {
    // An unchanged head with an unchanged commit count is no change at all;
    // match {@link hasChanges} so a caller that always renders never prints a
    // non-change line.
    if (change.fromOid === change.toOid && change.commits === 0) return ''
    const parts: string[] = [`${shortOid(change.fromOid)} -> ${shortOid(change.toOid)}`]
    if (change.commits > 0) parts.push(`+${change.commits} commit${change.commits === 1 ? '' : 's'}`)
    else if (change.commits < 0) parts.push(`${change.commits} commits (rewritten)`)
    return `changes: branch advanced ${parts.join(', ')}`
  }
  const parts: string[] = []
  if (change.headRefOid !== null) {
    parts.push(`head moved to ${shortOid(change.headRefOid)}`)
  }
  if (change.commits > 0) parts.push(`+${change.commits} commit${change.commits === 1 ? '' : 's'}`)
  if (change.reviews > 0) parts.push(`+${change.reviews} review${change.reviews === 1 ? '' : 's'}`)
  if (change.reviewThreads > 0) parts.push(`+${change.reviewThreads} review thread${change.reviewThreads === 1 ? '' : 's'}`)
  if (change.reviewComments > 0) parts.push(`+${change.reviewComments} review comment${change.reviewComments === 1 ? '' : 's'}`)
  if (change.issueComments > 0) parts.push(`+${change.issueComments} issue comment${change.issueComments === 1 ? '' : 's'}`)
  const checkParts: string[] = []
  if (change.checks.failed !== 0) checkParts.push(signedCount(change.checks.failed, 'failed'))
  if (change.checks.pending !== 0) checkParts.push(signedCount(change.checks.pending, 'pending'))
  if (change.checks.passed !== 0) checkParts.push(signedCount(change.checks.passed, 'passed'))
  if (checkParts.length > 0) parts.push(`checks: ${checkParts.join(', ')}`)
  if (change.newlyFailedChecks.length > 0) {
    parts.push(`newly failed: ${change.newlyFailedChecks.join(', ')}`)
  }
  if (change.mergeable !== null) {
    const from = change.mergeable.from ?? 'UNKNOWN'
    const to = change.mergeable.to ?? 'UNKNOWN'
    parts.push(`mergeable: ${from} -> ${to}`)
  }
  return parts.length === 0 ? '' : `changes: ${parts.join(', ')}`
}

/**
 * Build the notification text for a watch.
 * @param id - the watch id.
 * @param snapshot - the current snapshot.
 * @param satisfied - whether the selected conditions are currently met.
 * @param satisfiedEdge - whether this poll flipped the watch into satisfied.
 * @param change - the diff vs the previous poll, or null for the first poll.
 * @param ignoredComments - new comments dropped by the author filter this poll.
 * @returns the message text delivered to the target session.
 */
export function buildNotificationText(
  id: string,
  snapshot: WatchSnapshot,
  satisfied: boolean,
  satisfiedEdge: boolean,
  change: ChangeSummary | null,
  ignoredComments = 0,
): string {
  const lines: string[] = []
  if (snapshot.kind === 'branch') {
    lines.push(`PR watch "${id}" changed: ${snapshot.repo}@${snapshot.branch} (${snapshot.url})`)
    lines.push(`branch: ${snapshot.branch}`)
    lines.push(`head: ${snapshot.headOid}${snapshot.committedDate === '' ? '' : ` (${snapshot.committedDate})`}`)
    lines.push(`commits: ${snapshot.commits}`)
    if (change !== null) {
      const changesLine = renderChanges(change)
      if (changesLine !== '') lines.push(changesLine)
    }
    return lines.join('\n')
  }
  if (satisfiedEdge) {
    lines.push(`PR watch "${id}" conditions met: ${snapshot.repo}#${snapshot.number} (${snapshot.url})`)
  } else {
    lines.push(`PR watch "${id}" changed: ${snapshot.repo}#${snapshot.number} (${snapshot.url})`)
  }
  const stateLine = snapshot.state === 'MERGED' ? 'state: MERGED' : `state: ${snapshot.state}`
  lines.push(stateLine)
  lines.push(`checks: ${snapshot.checks.failed} failed, ${snapshot.checks.pending} pending of ${snapshot.checkContexts}`)
  if (snapshot.checksTruncated && snapshot.checkContexts > snapshot.checks.total) {
    lines.push(`note: ${snapshot.checkContexts} check contexts in total; only the newest ${snapshot.checks.total} were fetched, so the check counts above are partial`)
  }
  lines.push(`review threads: ${snapshot.unresolvedThreads} unresolved of ${snapshot.reviewThreads}`)
  if (snapshot.threadsTruncated) {
    lines.push(`note: ${snapshot.reviewThreads} review threads in total; only the newest 100 were fetched, so the unresolved count above is partial`)
  }
  if (snapshot.mergeable !== null) lines.push(`mergeable: ${snapshot.mergeable}`)
  if (snapshot.reviewDecision !== null) lines.push(`review decision: ${snapshot.reviewDecision}`)
  if (change !== null) {
    const changesLine = renderChanges(change)
    if (changesLine !== '') lines.push(changesLine)
    const newComments = change.kind === 'pr' ? change.newComments : []
    if (newComments.length > 0) {
      lines.push('new comments:')
      const shown = newComments.slice(0, NOTICE_COMMENT_LIMIT)
      for (const entry of shown) lines.push(renderCommentLine(entry))
      const hidden = newComments.length - shown.length
      if (hidden > 0) lines.push(`+${hidden} more`)
    }
    if (ignoredComments > 0) {
      lines.push(`note: ${ignoredComments} new comment${ignoredComments === 1 ? '' : 's'} from a filtered author ${ignoredComments === 1 ? 'was' : 'were'} ignored`)
    }
  }
  if (satisfiedEdge) {
    lines.push('watch satisfied; notifications for this watch stop here')
  }
  return lines.join('\n')
}

/** Comment entries rendered inline in one notification. */
const NOTICE_COMMENT_LIMIT = 6
/** Per-comment body bound in notification text. */
const NOTICE_COMMENT_BODY_LIMIT = 500

/** Render one conversation entry as a single notification line. */
export function renderCommentLine(entry: ConversationEntry): string {
  const location = entry.kind === 'inline' ? (entry.path ?? '') : ''
  const tag = entry.kind === 'issue' ? 'issue'
    : entry.kind === 'review' ? 'review'
      : location === '' ? 'inline' : `inline ${location}`
  const body = entry.body.replace(/\n+/g, ' / ')
  const clipped = body.length > NOTICE_COMMENT_BODY_LIMIT ? `${body.slice(0, NOTICE_COMMENT_BODY_LIMIT)}…` : body
  const time = entry.createdAt.length > 19 ? entry.createdAt.slice(0, 19).replace('T', ' ') : entry.createdAt
  return `[${tag}] ${entry.author} (${time}): ${clipped}`
}
