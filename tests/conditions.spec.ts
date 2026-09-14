/** Condition evaluation, change detection, and notification text building. */
import { describe, expect, it } from 'vitest'
import {
  buildNotificationText,
  conditionsMet,
  diffSnapshots,
  evaluateConditions,
  filterCommentAuthors,
  hasChanges,
  renderChanges,
} from '../src/pr-watcher/conditions.ts'
import { hasChanges as hasChangesGuard } from '../src/pr-watcher/types.ts'
import type { BranchChangeSummary, BranchSnapshot, PrChangeSummary, PrSnapshot } from '../src/pr-watcher/types.ts'

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    kind: 'pr',
    repo: 'example-org/example-repo',
    number: 1,
    url: 'https://example.invalid/pr/1',
    state: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    headRefName: 'main',
    headRefOid: 'a'.repeat(40),
    commits: 1,
    reviews: 0,
    reviewThreads: 0,
    reviewComments: 0,
    issueComments: 0,
    unresolvedThreads: 0,
    checksTruncated: false,
    threadsTruncated: false,
    checkContexts: 1,
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    failedChecks: [],
    conversation: [],
    ...overrides,
  }
}

function branch(overrides: Partial<BranchSnapshot> = {}): BranchSnapshot {
  return {
    kind: 'branch',
    repo: 'example-org/example-repo',
    branch: 'master',
    url: 'https://example.invalid/tree/master',
    headOid: 'c'.repeat(40),
    committedDate: '2026-09-03T01:00:00Z',
    commits: 10,
    ...overrides,
  }
}

/** `diffSnapshots` narrowed to the PR branch of the change-summary union. */
function diffPr(prev: PrSnapshot, next: PrSnapshot): PrChangeSummary {
  const diff = diffSnapshots(prev, next)
  if (diff === null || diff.kind !== 'pr') throw new Error('expected a PR change summary')
  return diff
}

/** `diffSnapshots` narrowed to the branch branch of the change-summary union. */
function diffBranch(prev: BranchSnapshot, next: BranchSnapshot): BranchChangeSummary {
  const diff = diffSnapshots(prev, next)
  if (diff === null || diff.kind !== 'branch') throw new Error('expected a branch change summary')
  return diff
}

describe('evaluateConditions', () => {
  it('is all true for a settled, approved, mergeable PR', () => {
    const result = evaluateConditions(snapshot())
    expect(result).toEqual({
      checksPassed: true,
      checksFailed: false,
      threadsResolved: true,
      mergeable: true,
      conflicted: false,
      reviewApproved: true,
      merged: false,
      closed: false,
    })
  })

  it('checksPassed fails on any failed or pending check', () => {
    expect(evaluateConditions(snapshot({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } })).checksPassed).toBe(false)
    expect(evaluateConditions(snapshot({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } })).checksPassed).toBe(false)
  })

  it('checksFailed holds on any failed check and is exclusive with checksPassed', () => {
    const red = evaluateConditions(snapshot({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } }))
    expect(red.checksFailed).toBe(true)
    expect(red.checksPassed).toBe(false)
    const green = evaluateConditions(snapshot())
    expect(green.checksFailed).toBe(false)
    expect(green.checksPassed).toBe(true)
  })

  it('threadsResolved fails on unresolved threads', () => {
    expect(evaluateConditions(snapshot({ unresolvedThreads: 2 })).threadsResolved).toBe(false)
  })

  it('mergeable only on MERGEABLE, conflicted only on CONFLICTING', () => {
    expect(evaluateConditions(snapshot({ mergeable: 'CONFLICTING' })).mergeable).toBe(false)
    expect(evaluateConditions(snapshot({ mergeable: 'UNKNOWN' })).mergeable).toBe(false)
    expect(evaluateConditions(snapshot({ mergeable: null })).mergeable).toBe(false)
    const red = evaluateConditions(snapshot({ mergeable: 'CONFLICTING' }))
    expect(red.conflicted).toBe(true)
    expect(red.mergeable).toBe(false)
    const clean = evaluateConditions(snapshot({ mergeable: 'MERGEABLE' }))
    expect(clean.conflicted).toBe(false)
    expect(clean.mergeable).toBe(true)
  })

  it('reviewApproved only on APPROVED', () => {
    expect(evaluateConditions(snapshot({ reviewDecision: 'CHANGES_REQUESTED' })).reviewApproved).toBe(false)
    expect(evaluateConditions(snapshot({ reviewDecision: 'REVIEW_REQUIRED' })).reviewApproved).toBe(false)
    expect(evaluateConditions(snapshot({ reviewDecision: null })).reviewApproved).toBe(false)
  })

  it('merged and closed are mutually exclusive states', () => {
    const merged = evaluateConditions(snapshot({ state: 'MERGED', merged: true }))
    expect(merged.merged).toBe(true)
    expect(merged.closed).toBe(false)
    const closed = evaluateConditions(snapshot({ state: 'CLOSED', merged: false }))
    expect(closed.closed).toBe(true)
    expect(closed.merged).toBe(false)
  })
})

describe('conditionsMet', () => {
  it('is the AND of the selected conditions', () => {
    const result = evaluateConditions(snapshot())
    expect(conditionsMet(['checksPassed', 'mergeable'], result)).toBe(true)
    expect(conditionsMet(['checksPassed', 'merged'], result)).toBe(false)
  })

  it('an empty selection never satisfies', () => {
    expect(conditionsMet([], evaluateConditions(snapshot()))).toBe(false)
  })
})

describe('diffSnapshots', () => {
  const base = snapshot()

  it('reports positive deltas for activity counts', () => {
    const next = snapshot({ commits: 4, reviews: 3, reviewThreads: 2, reviewComments: 5, issueComments: 1 })
    expect(diffPr(base, next)).toEqual({
      kind: 'pr',
      headRefOid: null,
      headRefName: null,
      commits: 3,
      reviews: 3,
      reviewThreads: 2,
      reviewComments: 5,
      issueComments: 1,
      checks: { passed: 0, failed: 0, pending: 0 },
      newlyFailedChecks: [],
      mergeable: null,
      newComments: [],
    })
  })

  it('never reports negative activity deltas', () => {
    const next = snapshot({ commits: 0, reviews: 0 })
    expect(diffPr(base, next).commits).toBe(0)
    expect(diffPr(base, next).reviews).toBe(0)
  })

  it('reports signed check-run state deltas and newly failed names', () => {
    const before = snapshot({ checks: { total: 3, passed: 1, failed: 0, pending: 2 } })
    const after = snapshot({
      checks: { total: 3, passed: 2, failed: 1, pending: 0 },
      failedChecks: ['lint', 'test'],
    })
    const diff = diffPr(before, after)
    expect(diff.checks).toEqual({ passed: 1, failed: 1, pending: -2 })
    expect(diff.newlyFailedChecks).toEqual(['lint', 'test'])
    // A check that was already failing in the previous snapshot is not "newly failed".
    const stillRed = diffPr(
      snapshot({ checks: { total: 2, passed: 0, failed: 1, pending: 1 }, failedChecks: ['lint'] }),
      snapshot({ checks: { total: 2, passed: 1, failed: 1, pending: 0 }, failedChecks: ['lint', 'test'] }),
    )
    expect(stillRed.newlyFailedChecks).toEqual(['test'])
  })

  it('flags a mergeable transition with its from/to pair', () => {
    const diff = diffPr(
      snapshot({ mergeable: 'MERGEABLE' }),
      snapshot({ mergeable: 'CONFLICTING' }),
    )
    expect(diff.mergeable).toEqual({ from: 'MERGEABLE', to: 'CONFLICTING' })
    expect(hasChanges(diff)).toBe(true)
    expect(renderChanges(diff)).toContain('mergeable: MERGEABLE -> CONFLICTING')
    // UNKNOWN stays a no-op only when it did not change.
    expect(diffPr(snapshot(), snapshot()).mergeable).toBeNull()
  })

  it('flags a moved head ref', () => {
    const next = snapshot({ headRefOid: 'b'.repeat(40), headRefName: 'feat/y' })
    const diff = diffPr(base, next)
    expect(diff.headRefOid).toBe('b'.repeat(40))
    expect(diff.headRefName).toBe('feat/y')
  })

  it('reports comment entries added since the previous snapshot', () => {
    const first = { key: 'issue-1', kind: 'issue' as const, author: 'alice', createdAt: '2026-09-03T01:00:00Z', body: 'first', url: 'u1' }
    const second = { key: 'inline-2', kind: 'inline' as const, author: 'bob', createdAt: '2026-09-03T02:00:00Z', body: 'second', url: 'u2', path: 'src/x.ts' }
    const before = snapshot({ conversation: [first] })
    const after = snapshot({ conversation: [second, first] })
    const diff = diffPr(before, after)
    expect(diff.newComments).toEqual([second])
    // Same window twice is no change.
    expect(diffPr(before, before).newComments).toEqual([])
  })
})

describe('hasChanges / renderChanges', () => {
  it('null and empty diffs are not changes', () => {
    expect(hasChangesGuard(null)).toBe(false)
    expect(hasChanges(diffSnapshots(snapshot(), snapshot()))).toBe(false)
  })

  it('counts a check-run state transition as a change', () => {
    const diff = diffPr(
      snapshot({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }),
      snapshot({ checks: { total: 2, passed: 1, failed: 1, pending: 0 }, failedChecks: ['lint'] }),
    )
    expect(hasChanges(diff)).toBe(true)
    const line = renderChanges(diff)
    expect(line).toContain('checks: +1 failed, -1 pending')
    expect(line).toContain('newly failed: lint')
  })

  it('renders a compact changes line', () => {
    const diff = diffPr(snapshot(), snapshot({ commits: 4, reviewComments: 2, headRefOid: 'b'.repeat(40) }))
    expect(hasChanges(diff)).toBe(true)
    const line = renderChanges(diff)
    expect(line).toContain('+3 commits')
    expect(line).toContain('+2 review comments')
    expect(line).toContain('head moved to bbbbbbbb')
  })
})

describe('buildNotificationText', () => {
  it('names the satisfied transition and shows the full state', () => {
    const text = buildNotificationText('watch-1', snapshot(), true, true, null)
    expect(text).toContain('PR watch "watch-1" conditions met: example-org/example-repo#1')
    expect(text).toContain('checks: 0 failed, 0 pending of 1')
    expect(text).toContain('review threads: 0 unresolved of 0')
    expect(text).toContain('mergeable: MERGEABLE')
    expect(text).toContain('review decision: APPROVED')
    expect(text).toContain('watch satisfied; notifications for this watch stop here')
  })

  it('names change notifications without the satisfied line', () => {
    const text = buildNotificationText('watch-1', snapshot({ commits: 2 }), false, false, {
      kind: 'pr',
      headRefOid: null,
      headRefName: null,
      commits: 1,
      reviews: 0,
      reviewThreads: 0,
      reviewComments: 0,
      issueComments: 0,
      checks: { passed: 0, failed: 0, pending: 0 },
      newlyFailedChecks: [],
      mergeable: null,
      newComments: [],
    })
    expect(text).toContain('PR watch "watch-1" changed')
    expect(text).toContain('+1 commit')
    expect(text).not.toContain('conditions met')
    expect(text).not.toContain('notifications for this watch stop')
  })

  it('shows state for merged PRs', () => {
    const text = buildNotificationText('watch-1', snapshot({ state: 'MERGED', merged: true }), true, true, null)
    expect(text).toContain('state: MERGED')
  })

  it('embeds newly arrived comment bodies in the notification', () => {
    const comment = {
      key: 'inline-9',
      kind: 'inline' as const,
      author: 'bob',
      createdAt: '2026-09-03T02:00:00Z',
      body: 'this branch looks unreachable\nplease handle it',
      url: 'u',
      path: 'src/x.ts',
    }
    const change = {
      kind: 'pr' as const,
      headRefOid: null,
      headRefName: null,
      commits: 0,
      reviews: 0,
      reviewThreads: 1,
      reviewComments: 1,
      issueComments: 0,
      checks: { passed: 0, failed: 0, pending: 0 },
      newlyFailedChecks: [],
      mergeable: null,
      newComments: [comment],
    }
    const text = buildNotificationText('watch-1', snapshot(), false, false, change)
    expect(text).toContain('new comments:')
    expect(text).toContain('[inline src/x.ts] bob (2026-09-03 02:00:00): this branch looks unreachable / please handle it')
  })
})

describe('truncation fail-closed', () => {
  it('checksPassed fails closed when the context window was truncated', () => {
    const result = evaluateConditions(snapshot({ checksTruncated: true }))
    expect(result.checksPassed).toBe(false)
    expect(evaluateConditions(snapshot()).checksPassed).toBe(true)
  })

  it('threadsResolved fails closed when the thread window was truncated', () => {
    const result = evaluateConditions(snapshot({ threadsTruncated: true }))
    expect(result.threadsResolved).toBe(false)
    expect(evaluateConditions(snapshot()).threadsResolved).toBe(true)
  })
})

describe('truncation reporting', () => {
  it('states the hidden counts in the notification when windows are truncated', () => {
    const text = buildNotificationText('watch-1', snapshot({
      checks: { total: 100, passed: 99, failed: 0, pending: 1 },
      checkContexts: 250,
      checksTruncated: true,
      reviewThreads: 340,
      threadsTruncated: true,
    }), false, false, null)
    // The denominator is the real context total, consistent with the threads line.
    expect(text).toContain('checks: 0 failed, 1 pending of 250')
    expect(text).toContain('250 check contexts in total; only the newest 100 were fetched')
    expect(text).toContain('340 review threads in total; only the newest 100 were fetched')
  })

  it('adds no truncation notes for untruncated snapshots', () => {
    const text = buildNotificationText('watch-1', snapshot(), false, false, null)
    expect(text).not.toContain('note:')
  })
})

describe('branch snapshots', () => {
  it('diffs a branch advance as oids plus a commit delta', () => {
    const before = branch()
    const after = branch({ headOid: 'd'.repeat(40), commits: 13, committedDate: '2026-09-04T01:00:00Z' })
    expect(diffBranch(before, after)).toEqual({
      kind: 'branch',
      fromOid: 'c'.repeat(40),
      toOid: 'd'.repeat(40),
      commits: 3,
      committedDate: '2026-09-04T01:00:00Z',
    })
  })

  it('treats an unchanged branch as no change', () => {
    expect(hasChangesGuard(diffSnapshots(branch(), branch()))).toBe(false)
    expect(renderChanges(diffBranch(branch(), branch()))).toBe('')
  })

  it('returns null when the compared targets have different kinds', () => {
    expect(diffSnapshots(branch(), snapshot())).toBeNull()
    expect(diffSnapshots(snapshot(), branch())).toBeNull()
  })

  it('renders an advance and a rewrite', () => {
    const advanced = diffBranch(branch(), branch({ headOid: 'd'.repeat(40), commits: 11 }))
    expect(hasChanges(advanced)).toBe(true)
    expect(renderChanges(advanced)).toBe('changes: branch advanced cccccccc -> dddddddd, +1 commit')
    const rewritten = diffBranch(branch(), branch({ headOid: 'd'.repeat(40), commits: 8 }))
    expect(renderChanges(rewritten)).toBe('changes: branch advanced cccccccc -> dddddddd, -2 commits (rewritten)')
  })

  it('builds a branch notification with the head, commit count, and change line', () => {
    const change = diffBranch(branch(), branch({ headOid: 'd'.repeat(40), commits: 12 }))
    const text = buildNotificationText('watch-b', branch({ headOid: 'd'.repeat(40), commits: 12 }), false, false, change)
    expect(text).toContain('PR watch "watch-b" changed: example-org/example-repo@master (https://example.invalid/tree/master)')
    expect(text).toContain('branch: master')
    expect(text).toContain(`head: ${'d'.repeat(40)} (2026-09-03T01:00:00Z)`)
    expect(text).toContain('commits: 12')
    expect(text).toContain('changes: branch advanced cccccccc -> dddddddd, +2 commits')
    expect(text).not.toContain('conditions met')
  })

  it('omits the changes line on the first poll of a branch watch', () => {
    const text = buildNotificationText('watch-b', branch({ committedDate: '' }), false, false, null)
    expect(text).toContain(`head: ${'c'.repeat(40)}`)
    expect(text).not.toContain('changes:')
  })
})

describe('filterCommentAuthors', () => {
  const mine = {
    key: 'issue-1',
    kind: 'issue' as const,
    author: 'watching-account',
    createdAt: '2026-09-03T02:00:00Z',
    body: 'my own reply',
    url: 'u1',
  }
  const theirs = {
    key: 'issue-2',
    kind: 'issue' as const,
    author: 'reviewer',
    createdAt: '2026-09-03T03:00:00Z',
    body: 'please rename this',
    url: 'u2',
  }

  /** A PR change summary whose only news is `comments` plus the given deltas. */
  function changeWith(overrides: Partial<PrChangeSummary> = {}): PrChangeSummary {
    return {
      kind: 'pr',
      headRefOid: null,
      headRefName: null,
      commits: 0,
      reviews: 0,
      reviewThreads: 0,
      reviewComments: 0,
      issueComments: 0,
      checks: { passed: 0, failed: 0, pending: 0 },
      newlyFailedChecks: [],
      mergeable: null,
      newComments: [],
      ...overrides,
    }
  }

  it('returns the summary untouched for an empty filter or no new comments', () => {
    const clean = changeWith({ issueComments: 1, newComments: [mine] })
    expect(filterCommentAuthors(clean, [])).toEqual({ change: clean, ignoredComments: 0 })
    const none = changeWith({ commits: 1 })
    expect(filterCommentAuthors(none, ['watching-account'])).toEqual({ change: none, ignoredComments: 0 })
  })

  it('drops own comments and the count delta they account for', () => {
    const change = changeWith({ issueComments: 1, newComments: [mine] })
    const result = filterCommentAuthors(change, ['watching-account'])
    expect(result.ignoredComments).toBe(1)
    expect(result.change.newComments).toEqual([])
    expect(result.change.issueComments).toBe(0)
    // Nothing else moved, so the whole poll is not a change.
    expect(hasChanges(result.change)).toBe(false)
  })

  it('matches authors case-insensitively and keeps other authors', () => {
    const change = changeWith({ issueComments: 2, newComments: [theirs, mine] })
    const result = filterCommentAuthors(change, ['Watching-Account'])
    expect(result.change.newComments).toEqual([theirs])
    expect(result.change.issueComments).toBe(1)
    expect(result.ignoredComments).toBe(1)
    expect(hasChanges(result.change)).toBe(true)
  })

  it('reduces review and inline deltas by the kinds it dropped', () => {
    const review = { ...mine, key: 'review-3', kind: 'review' as const }
    const inline = { ...mine, key: 'inline-4', kind: 'inline' as const }
    const change = changeWith({
      reviews: 1,
      reviewComments: 1,
      reviewThreads: 1,
      newComments: [inline, review],
    })
    const result = filterCommentAuthors(change, ['watching-account'])
    expect(result.change.reviews).toBe(0)
    expect(result.change.reviewComments).toBe(0)
    // A review thread that a filtered inline comment created is not explained
    // by comment counts alone, so it stays a change.
    expect(result.change.reviewThreads).toBe(1)
    expect(hasChanges(result.change)).toBe(true)
  })

  it('never floors a count below zero when the window hides other comments', () => {
    // Two comments arrived in total but only one (mine) is inside the window.
    const change = changeWith({ issueComments: 2, newComments: [mine] })
    const result = filterCommentAuthors(change, ['watching-account'])
    expect(result.change.issueComments).toBe(1)
    expect(hasChanges(result.change)).toBe(true)
  })

  it('reports the ignored count in the notification text', () => {
    const change = changeWith({ commits: 1, issueComments: 1, newComments: [mine] })
    const result = filterCommentAuthors(change, ['watching-account'])
    const text = buildNotificationText('watch-1', snapshot(), false, false, result.change, result.ignoredComments)
    expect(text).toContain('+1 commit')
    expect(text).not.toContain('+1 issue comment')
    expect(text).not.toContain('new comments:')
    expect(text).toContain('note: 1 new comment from a filtered author was ignored')
  })

  it('pluralizes the ignored-comment note', () => {
    const second = { ...mine, key: 'issue-5' }
    const change = changeWith({ commits: 1, newComments: [mine, second] })
    const result = filterCommentAuthors(change, ['watching-account'])
    const text = buildNotificationText('watch-1', snapshot(), false, false, result.change, result.ignoredComments)
    expect(text).toContain('note: 2 new comments from a filtered author were ignored')
  })
})
