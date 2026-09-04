/** gh CLI wiring and GraphQL → PrSnapshot mapping. */
import { describe, expect, it } from 'vitest'
import {
  buildGhArgs,
  conversationCountsChanged,
  conversationFromRest,
  parseRepo,
  PR_QUERY,
  snapshotFromGraphql,
} from '../src/pr-watcher/gh.ts'

function fixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    repository: {
      pullRequest: {
        url: 'https://github.com/example-org/example-repo/pull/1',
        state: 'OPEN',
        merged: false,
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
        headRefName: 'feat/x',
        headRefOid: 'a'.repeat(40),
        commits: { totalCount: 3 },
        reviews: { totalCount: 2 },
        comments: { totalCount: 1 },
        reviewThreads: {
          totalCount: 2,
          nodes: [
            { isResolved: true, comments: { totalCount: 2 } },
            { isResolved: false, comments: { totalCount: 1 } },
          ],
        },
        statusCheckRollup: {
          state: 'FAILURE',
          contexts: {
            totalCount: 4,
            nodes: [
              { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
              { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
              { __typename: 'StatusContext', context: 'ci', state: 'PENDING' },
              { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null },
            ],
          },
        },
        ...overrides,
      },
    },
  }
}

describe('parseRepo', () => {
  it('splits owner/name', () => {
    expect(parseRepo('example-org/example-repo')).toEqual({ owner: 'example-org', name: 'example-repo' })
  })

  it('rejects references without a slash or with extra path', () => {
    expect(() => parseRepo('bare-name')).toThrow(/owner\/name/)
    expect(() => parseRepo('a/b/c')).toThrow(/owner\/name/)
    expect(() => parseRepo('')).toThrow(/owner\/name/)
  })
})

describe('buildGhArgs', () => {
  it('builds the gh api graphql argument vector with -F pairs', () => {
    expect(buildGhArgs('query Q {}', { owner: 'o', name: 'n', number: '7' })).toEqual([
      'api', 'graphql', '-F', 'query=query Q {}',
      '-F', 'owner=o', '-F', 'name=n', '-F', 'number=7',
    ])
  })
})

describe('PR_QUERY', () => {
  it('selects every field the snapshot needs', () => {
    for (const field of ['reviewThreads', 'statusCheckRollup', 'mergeable', 'reviewDecision', 'headRefOid']) {
      expect(PR_QUERY).toContain(field)
    }
  })
})

describe('snapshotFromGraphql', () => {
  it('maps a full PR payload', () => {
    const snapshot = snapshotFromGraphql('example-org/example-repo', 1, fixture())
    expect(snapshot).toMatchObject({
      repo: 'example-org/example-repo',
      number: 1,
      url: 'https://github.com/example-org/example-repo/pull/1',
      state: 'OPEN',
      merged: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      headRefName: 'feat/x',
      headRefOid: 'a'.repeat(40),
      commits: 3,
      reviews: 2,
      reviewThreads: 2,
      reviewComments: 3,
      issueComments: 1,
      unresolvedThreads: 1,
      checks: { total: 4, passed: 1, failed: 1, pending: 2 },
      failedChecks: ['lint'],
    })
  })

  it('collects failing run names from both CheckRun and StatusContext', () => {
    const snapshot = snapshotFromGraphql('example-org/example-repo', 1, fixture({
      statusCheckRollup: {
        state: 'FAILURE',
        contexts: {
          totalCount: 3,
          nodes: [
            { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
            { __typename: 'StatusContext', context: 'ci/gate', state: 'ERROR' },
            { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        },
      },
    }))
    expect(snapshot.failedChecks).toEqual(['lint', 'ci/gate'])
  })

  it('throws when the repository or PR does not exist', () => {
    expect(() => snapshotFromGraphql('example-org/example-repo', 9, { repository: { pullRequest: null } }))
      .toThrow(/not found/)
    expect(() => snapshotFromGraphql('example-org/example-repo', 9, {}))
      .toThrow(/not found/)
  })

  it('normalizes absent mergeable and reviewDecision to null', () => {
    const snapshot = snapshotFromGraphql('example-org/example-repo', 1, fixture({ mergeable: null, reviewDecision: null }))
    expect(snapshot.mergeable).toBeNull()
    expect(snapshot.reviewDecision).toBeNull()
  })

  it('distinguishes MERGED from CLOSED', () => {
    const merged = snapshotFromGraphql('example-org/example-repo', 1, fixture({ state: 'MERGED', merged: true }))
    expect(merged.state).toBe('MERGED')
    expect(merged.merged).toBe(true)
    const closed = snapshotFromGraphql('example-org/example-repo', 1, fixture({ state: 'CLOSED', merged: false }))
    expect(closed.state).toBe('CLOSED')
    expect(closed.merged).toBe(false)
  })

  it('survives null rollup nodes and missing counts', () => {
    const snapshot = snapshotFromGraphql('example-org/example-repo', 1, fixture({
      statusCheckRollup: {
        state: null,
        contexts: {
          totalCount: undefined,
          nodes: [null, undefined, { __typename: 'CheckRun', status: null, conclusion: null }],
        },
      },
      reviewThreads: { totalCount: undefined, nodes: [null] },
    }))
    expect(snapshot.checks).toEqual({ total: 1, passed: 0, failed: 0, pending: 1 })
    expect(snapshot.reviewThreads).toBe(0)
    expect(snapshot.reviewComments).toBe(0)
    expect(snapshot.unresolvedThreads).toBe(0)
  })
})

describe('conversationFromRest', () => {
  it('merges issue, inline, and review-summary comments newest first', () => {
    const entries = conversationFromRest(
      [{ id: 1, user: { login: 'alice' }, created_at: '2026-09-03T01:00:00Z', body: 'why?', html_url: 'u1' }],
      [{ id: 2, user: { login: 'bob' }, created_at: '2026-09-03T03:00:00Z', body: 'inline note', html_url: 'u2', path: 'src/x.ts' }],
      [
        { id: 3, user: { login: 'carol' }, created_at: '2026-09-03T02:00:00Z', body: 'summary', html_url: 'u3' },
        { id: 4, user: { login: 'dave' }, created_at: '2026-09-03T01:30:00Z', body: '', html_url: 'u4' },
      ],
    )
    expect(entries.map((e) => e.key)).toEqual(['inline-2', 'review-3', 'issue-1'])
    expect(entries[0]).toMatchObject({ kind: 'inline', author: 'bob', path: 'src/x.ts' })
    expect(entries[1]).toMatchObject({ kind: 'review', author: 'carol' })
    // Empty review summaries (pure inline reviews) are dropped.
    expect(entries.some((e) => e.key === 'review-4')).toBe(false)
  })

  it('caps the window and truncates long bodies', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      user: { login: 'u' },
      created_at: `2026-09-03T00:${String(i).padStart(2, '0')}:00Z`,
      body: 'x',
      html_url: 'u',
    }))
    const entries = conversationFromRest(many, [], [])
    expect(entries.length).toBeLessThanOrEqual(15)
    expect(entries[0]?.createdAt).toBe('2026-09-03T00:19:00Z')
    const long = conversationFromRest(
      [{ id: 1, user: { login: 'u' }, created_at: '2026-09-03T01:00:00Z', body: 'y'.repeat(3000), html_url: 'u' }],
      [],
      [],
    )
    expect(long[0]?.body.length).toBeLessThanOrEqual(2001)
    expect(long[0]?.body.endsWith('…')).toBe(true)
  })
})

describe('conversationCountsChanged', () => {
  it('is true only when a conversation-affecting count moved', () => {
    const a = snapshotFromGraphql('example-org/example-repo', 1, fixture())
    const same = snapshotFromGraphql('example-org/example-repo', 1, fixture())
    expect(conversationCountsChanged(a, same)).toBe(false)
    const moreComments = snapshotFromGraphql('example-org/example-repo', 1, fixture({ comments: { totalCount: 2 } }))
    expect(conversationCountsChanged(a, moreComments)).toBe(true)
  })
})
