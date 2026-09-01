/** gh CLI wiring and GraphQL → PrSnapshot mapping. */
import { describe, expect, it } from 'vitest'
import { buildGhArgs, parseRepo, PR_QUERY, snapshotFromGraphql } from '../src/pr-watcher/gh.ts'

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
    })
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
