/** Condition evaluation, change detection, and notification text building. */
import { describe, expect, it } from 'vitest'
import {
  buildNotificationText,
  conditionsMet,
  diffSnapshots,
  evaluateConditions,
  hasChanges,
  renderChanges,
} from '../src/pr-watcher/conditions.ts'
import { hasChanges as hasChangesGuard } from '../src/pr-watcher/types.ts'
import type { PrSnapshot } from '../src/pr-watcher/types.ts'

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
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
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    failedChecks: [],
    ...overrides,
  }
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
    expect(diffSnapshots(base, next)).toEqual({
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
    })
  })

  it('never reports negative activity deltas', () => {
    const next = snapshot({ commits: 0, reviews: 0 })
    expect(diffSnapshots(base, next).commits).toBe(0)
    expect(diffSnapshots(base, next).reviews).toBe(0)
  })

  it('reports signed check-run state deltas and newly failed names', () => {
    const before = snapshot({ checks: { total: 3, passed: 1, failed: 0, pending: 2 } })
    const after = snapshot({
      checks: { total: 3, passed: 2, failed: 1, pending: 0 },
      failedChecks: ['lint', 'test'],
    })
    const diff = diffSnapshots(before, after)
    expect(diff.checks).toEqual({ passed: 1, failed: 1, pending: -2 })
    expect(diff.newlyFailedChecks).toEqual(['lint', 'test'])
    // A check that was already failing in the previous snapshot is not "newly failed".
    const stillRed = diffSnapshots(
      snapshot({ checks: { total: 2, passed: 0, failed: 1, pending: 1 }, failedChecks: ['lint'] }),
      snapshot({ checks: { total: 2, passed: 1, failed: 1, pending: 0 }, failedChecks: ['lint', 'test'] }),
    )
    expect(stillRed.newlyFailedChecks).toEqual(['test'])
  })

  it('flags a mergeable transition with its from/to pair', () => {
    const diff = diffSnapshots(
      snapshot({ mergeable: 'MERGEABLE' }),
      snapshot({ mergeable: 'CONFLICTING' }),
    )
    expect(diff.mergeable).toEqual({ from: 'MERGEABLE', to: 'CONFLICTING' })
    expect(hasChanges(diff)).toBe(true)
    expect(renderChanges(diff)).toContain('mergeable: MERGEABLE -> CONFLICTING')
    // UNKNOWN stays a no-op only when it did not change.
    expect(diffSnapshots(snapshot(), snapshot()).mergeable).toBeNull()
  })

  it('flags a moved head ref', () => {
    const next = snapshot({ headRefOid: 'b'.repeat(40), headRefName: 'feat/y' })
    const diff = diffSnapshots(base, next)
    expect(diff.headRefOid).toBe('b'.repeat(40))
    expect(diff.headRefName).toBe('feat/y')
  })
})

describe('hasChanges / renderChanges', () => {
  it('null and empty diffs are not changes', () => {
    expect(hasChangesGuard(null)).toBe(false)
    expect(hasChanges(diffSnapshots(snapshot(), snapshot()))).toBe(false)
  })

  it('counts a check-run state transition as a change', () => {
    const diff = diffSnapshots(
      snapshot({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }),
      snapshot({ checks: { total: 2, passed: 1, failed: 1, pending: 0 }, failedChecks: ['lint'] }),
    )
    expect(hasChanges(diff)).toBe(true)
    const line = renderChanges(diff)
    expect(line).toContain('checks: +1 failed, -1 pending')
    expect(line).toContain('newly failed: lint')
  })

  it('renders a compact changes line', () => {
    const diff = diffSnapshots(snapshot(), snapshot({ commits: 4, reviewComments: 2, headRefOid: 'b'.repeat(40) }))
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
})
