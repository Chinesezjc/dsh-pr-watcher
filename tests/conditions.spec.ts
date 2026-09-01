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
    ...overrides,
  }
}

describe('evaluateConditions', () => {
  it('is all true for a settled, approved, mergeable PR', () => {
    const result = evaluateConditions(snapshot())
    expect(result).toEqual({
      checksPassed: true,
      threadsResolved: true,
      mergeable: true,
      reviewApproved: true,
      merged: false,
      closed: false,
    })
  })

  it('checksPassed fails on any failed or pending check', () => {
    expect(evaluateConditions(snapshot({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } })).checksPassed).toBe(false)
    expect(evaluateConditions(snapshot({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } })).checksPassed).toBe(false)
  })

  it('threadsResolved fails on unresolved threads', () => {
    expect(evaluateConditions(snapshot({ unresolvedThreads: 2 })).threadsResolved).toBe(false)
  })

  it('mergeable only on MERGEABLE', () => {
    expect(evaluateConditions(snapshot({ mergeable: 'CONFLICTING' })).mergeable).toBe(false)
    expect(evaluateConditions(snapshot({ mergeable: 'UNKNOWN' })).mergeable).toBe(false)
    expect(evaluateConditions(snapshot({ mergeable: null })).mergeable).toBe(false)
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

  it('reports positive deltas only', () => {
    const next = snapshot({ commits: 4, reviews: 3, reviewThreads: 2, reviewComments: 5, issueComments: 1 })
    expect(diffSnapshots(base, next)).toEqual({
      headRefOid: null,
      headRefName: null,
      commits: 3,
      reviews: 3,
      reviewThreads: 2,
      reviewComments: 5,
      issueComments: 1,
    })
  })

  it('never reports negative deltas', () => {
    const next = snapshot({ commits: 0, reviews: 0 })
    expect(diffSnapshots(base, next).commits).toBe(0)
    expect(diffSnapshots(base, next).reviews).toBe(0)
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
