/**
 * GitHub data access for `dsh-pr-watcher`: runs one GraphQL query through the
 * `gh` CLI (`gh api graphql`) and maps the response into a `PrSnapshot`.
 *
 * The `gh` CLI is the only data source: it reuses the operator's existing
 * GitHub authentication (keyring on desktop, `GH_TOKEN`/`GITHUB_TOKEN` on
 * servers), so the plugin stores no token itself. The watched repository is
 * always caller-supplied; no repository name is baked into this plugin.
 * @module dsh-pr-watcher
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CheckSummary, ConversationEntry, PrSnapshot } from './types.ts'

const execFileAsync = promisify(execFile)

/** Maximum comment bodies kept in one snapshot's conversation (newest first). */
export const CONVERSATION_LIMIT = 15
/** Per-comment body truncation bound applied when storing a conversation entry. */
export const CONVERSATION_BODY_LIMIT = 2000

/** One GraphQL round-trip for a PR's full status snapshot. */
export const PR_QUERY = `
query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url
      state
      merged
      mergeable
      reviewDecision
      headRefName
      headRefOid
      commits { totalCount }
      reviews(first: 1) { totalCount }
      comments(first: 1) { totalCount }
      reviewThreads(first: 100) {
        totalCount
        nodes {
          isResolved
          comments(first: 1) { totalCount }
        }
      }
      statusCheckRollup {
        state
        contexts(first: 100) {
          totalCount
          nodes {
            __typename
            ... on CheckRun { name status conclusion }
            ... on StatusContext { context state }
          }
        }
      }
    }
  }
}
`.trim()

/** Check conclusions that count as a failure. */
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
/** StatusContext states that count as a failure. */
const FAILED_STATES = new Set(['ERROR', 'FAILURE'])
/** CheckRun statuses that count as still pending. */
const PENDING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'REQUESTED', 'WAITING', 'PENDING'])
/** StatusContext states that count as still pending. */
const PENDING_STATES = new Set(['EXPECTED', 'PENDING'])

/**
 * Parse `owner/name` from a repository reference.
 * @param repo - repository reference, e.g. `<owner>/<repo>`.
 * @returns the split owner and name.
 * @throws when the reference is not `owner/name`.
 */
export function parseRepo(repo: string): { owner: string; name: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo.trim())
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`invalid repository reference "${repo}": expected owner/name`)
  }
  return { owner: match[1], name: match[2] }
}

/**
 * Build the `gh api graphql` argument vector for one query. Every variable is
 * passed with `-F` so `gh` JSON-encodes it: string variables arrive as JSON
 * strings and numeric variables (the PR number is an `Int!`) arrive as
 * numbers, which `-f` would flatten to strings and the server would reject.
 * @param query - the GraphQL document.
 * @param vars - variable values, each passed as `-F name=value`.
 */
export function buildGhArgs(query: string, vars: Record<string, string>): string[] {
  const args = ['api', 'graphql', '-F', `query=${query}`]
  for (const [key, value] of Object.entries(vars)) args.push('-F', `${key}=${value}`)
  return args
}

/**
 * Run one GraphQL query through the `gh` CLI and return the `data` payload.
 * @param ghPath - path or name of the `gh` executable.
 * @param query - the GraphQL document.
 * @param vars - string variable values.
 * @param timeoutMs - per-call timeout.
 * @returns the `data` object of the GraphQL response.
 * @throws on non-zero exit, invalid JSON, or GraphQL errors in the response.
 */
export async function ghGraphql(
  ghPath: string,
  query: string,
  vars: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const { stdout } = await execFileAsync(ghPath, buildGhArgs(query, vars), {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  const parsed = JSON.parse(stdout) as { data?: unknown; errors?: { message: string }[] }
  if (parsed.errors !== undefined && parsed.errors.length > 0) {
    throw new Error(`gh graphql: ${parsed.errors.map((error) => error.message).join('; ')}`)
  }
  return parsed.data
}

/** Raw GraphQL shape of one statusCheckRollup item. */
interface RollupItem {
  __typename?: string
  name?: string | null
  context?: string | null
  status?: string | null
  conclusion?: string | null
  state?: string | null
}

interface GraphQlPullRequest {
  url?: string | null
  state?: string | null
  merged?: boolean | null
  mergeable?: string | null
  reviewDecision?: string | null
  headRefName?: string | null
  headRefOid?: string | null
  commits?: { totalCount?: number } | null
  reviews?: { totalCount?: number } | null
  comments?: { totalCount?: number } | null
  reviewThreads?: {
    totalCount?: number
    nodes?: ({ isResolved?: boolean | null; comments?: { totalCount?: number } | null } | null)[]
  } | null
  statusCheckRollup?: {
    state?: string | null
    contexts?: {
      totalCount?: number
      nodes?: (RollupItem | null)[] | null
    } | null
  } | null
}

interface GraphQlData {
  repository?: { pullRequest?: GraphQlPullRequest | null } | null
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A failing rollup item's display name: CheckRun `name` or StatusContext `context`. */
function rollupItemName(item: RollupItem): string {
  return item.__typename === 'StatusContext'
    ? (item.context ?? '')
    : (item.name ?? '')
}

/** Roll up the per-item check states into counts plus the names of failing runs. */
function summarizeChecks(items: (RollupItem | null)[]): { checks: CheckSummary; failedChecks: string[] } {
  let total = 0
  let passed = 0
  let failed = 0
  let pending = 0
  const failedChecks: string[] = []
  for (const item of items) {
    if (item === null || item === undefined) continue
    total += 1
    if (item.__typename === 'StatusContext') {
      const state = item.state
      if (state !== undefined && state !== null) {
        if (FAILED_STATES.has(state)) {
          failed += 1
          const name = rollupItemName(item)
          if (name !== '') failedChecks.push(name)
        } else if (PENDING_STATES.has(state)) pending += 1
        else if (state === 'SUCCESS') passed += 1
      }
      continue
    }
    const status = item.status
    const conclusion = item.conclusion
    if (conclusion !== undefined && conclusion !== null && FAILED_CONCLUSIONS.has(conclusion)) {
      failed += 1
      const name = rollupItemName(item)
      if (name !== '') failedChecks.push(name)
      continue
    }
    if (status !== undefined && status !== null && PENDING_STATUSES.has(status)) {
      pending += 1
      continue
    }
    if (conclusion === undefined || conclusion === null) {
      pending += 1
      continue
    }
    if (conclusion === 'SUCCESS' && status === 'COMPLETED') passed += 1
  }
  return { checks: { total, passed, failed, pending }, failedChecks }
}

function normalizeState(value: string | null | undefined): 'OPEN' | 'MERGED' | 'CLOSED' {
  if (value === 'MERGED') return 'MERGED'
  if (value === 'CLOSED') return 'CLOSED'
  return 'OPEN'
}

function normalizeMergeable(value: string | null | undefined): PrSnapshot['mergeable'] {
  if (value === 'MERGEABLE' || value === 'CONFLICTING' || value === 'UNKNOWN' || value === 'BLOCKED' || value === 'BEHIND') {
    return value
  }
  return null
}

function normalizeReviewDecision(value: string | null | undefined): PrSnapshot['reviewDecision'] {
  if (value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED') return value
  return null
}

/**
 * Map a GraphQL `data` payload into a `PrSnapshot`.
 * @param repo - the `owner/name` the query ran against, echoed into the snapshot.
 * @param number - the PR number, echoed into the snapshot.
 * @param data - the GraphQL `data` object.
 * @returns the snapshot.
 * @throws when the repository or pull request does not exist.
 */
export function snapshotFromGraphql(repo: string, number: number, data: unknown): PrSnapshot {
  const pullRequest = (data as GraphQlData)?.repository?.pullRequest
  if (pullRequest === undefined || pullRequest === null) {
    throw new Error(`pull request ${repo}#${number} not found`)
  }
  let unresolvedThreads = 0
  let reviewComments = 0
  for (const node of pullRequest.reviewThreads?.nodes ?? []) {
    if (node === null || node === undefined) continue
    if (node.isResolved === false) unresolvedThreads += 1
    reviewComments += numberOr(node.comments?.totalCount, 0)
  }
  const { checks, failedChecks } = summarizeChecks(pullRequest.statusCheckRollup?.contexts?.nodes ?? [])
  return {
    repo,
    number,
    url: pullRequest.url ?? '',
    state: normalizeState(pullRequest.state),
    merged: pullRequest.merged === true,
    mergeable: normalizeMergeable(pullRequest.mergeable),
    reviewDecision: normalizeReviewDecision(pullRequest.reviewDecision),
    headRefName: pullRequest.headRefName ?? '',
    headRefOid: pullRequest.headRefOid ?? '',
    commits: numberOr(pullRequest.commits?.totalCount, 0),
    reviews: numberOr(pullRequest.reviews?.totalCount, 0),
    reviewThreads: numberOr(pullRequest.reviewThreads?.totalCount, 0),
    reviewComments,
    issueComments: numberOr(pullRequest.comments?.totalCount, 0),
    unresolvedThreads,
    checks,
    failedChecks,
    // The conversation window is attached by the caller (service) after the
    // optional REST fetch; a bare mapping starts with an empty window.
    conversation: [],
  }
}

/**
 * Whether the conversation-affecting counts differ between two snapshots.
 * The conversation content is only fetched over REST when this returns true,
 * so a watch that sees no comment activity never pays for the extra calls.
 */
export function conversationCountsChanged(prev: PrSnapshot, next: PrSnapshot): boolean {
  return prev.issueComments !== next.issueComments
    || prev.reviews !== next.reviews
    || prev.reviewThreads !== next.reviewThreads
    || prev.reviewComments !== next.reviewComments
}

/** Raw REST shapes for the conversation endpoints. */
interface RestComment {
  id?: number
  user?: { login?: string | null } | null
  created_at?: string | null
  body?: string | null
  html_url?: string | null
  path?: string | null
}

interface RestReview {
  id?: number
  user?: { login?: string | null } | null
  created_at?: string | null
  body?: string | null
  html_url?: string | null
}

/** Run one `gh api` REST request and parse the JSON body. */
async function ghApiJson(ghPath: string, apiPath: string, timeoutMs: number): Promise<unknown> {
  const { stdout } = await execFileAsync(ghPath, ['api', apiPath], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(stdout) as unknown
}

function truncateBody(body: string | null | undefined): string {
  if (body === undefined || body === null) return ''
  return body.length > CONVERSATION_BODY_LIMIT
    ? `${body.slice(0, CONVERSATION_BODY_LIMIT)}…`
    : body
}

function toEntry(kind: ConversationEntry['kind'], id: number | undefined, raw: RestComment): ConversationEntry | null {
  if (id === undefined) return null
  return {
    key: `${kind}-${id}`,
    kind,
    author: raw.user?.login ?? 'unknown',
    createdAt: raw.created_at ?? '',
    body: truncateBody(raw.body),
    url: raw.html_url ?? '',
    ...(raw.path === undefined || raw.path === null ? {} : { path: raw.path }),
  }
}

/**
 * Build the newest-first conversation window from the three REST list
 * payloads. Review summaries with an empty body (pure inline reviews) are
 * dropped. The merged window is capped at {@link CONVERSATION_LIMIT}.
 * @param issueComments - payload of `issues/{n}/comments` (newest first).
 * @param reviewComments - payload of `pulls/{n}/comments` (newest first).
 * @param reviews - payload of `pulls/{n}/reviews`.
 */
export function conversationFromRest(
  issueComments: RestComment[],
  reviewComments: RestComment[],
  reviews: RestReview[],
): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (const raw of issueComments) {
    const entry = toEntry('issue', raw.id, raw)
    if (entry !== null) entries.push(entry)
  }
  for (const raw of reviewComments) {
    const entry = toEntry('inline', raw.id, raw)
    if (entry !== null) entries.push(entry)
  }
  for (const raw of reviews) {
    if (raw.body === undefined || raw.body === null || raw.body === '') continue
    const entry = toEntry('review', raw.id, raw)
    if (entry !== null) entries.push(entry)
  }
  return entries
    .filter((entry) => entry.createdAt !== '')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, CONVERSATION_LIMIT)
}

/**
 * Fetch the newest conversation comments of one PR over three REST calls:
 * issue comments, inline review comments, and review summaries. Comment
 * counts rarely change, so callers gate this on
 * {@link conversationCountsChanged} to avoid the extra calls on quiet polls.
 * @param ghPath - path or name of the `gh` executable.
 * @param repo - repository as `owner/name`.
 * @param number - pull request number.
 * @param timeoutMs - per-call timeout.
 * @returns the newest-first conversation window (empty on any fetch failure is
 * NOT produced here — failures throw, the caller keeps the previous window).
 * @throws on non-zero exit or invalid JSON from any of the three calls.
 */
export async function fetchConversation(
  ghPath: string,
  repo: string,
  number: number,
  timeoutMs: number,
): Promise<ConversationEntry[]> {
  const { owner, name } = parseRepo(repo)
  const [issueComments, reviewComments, reviews] = await Promise.all([
    ghApiJson(
      ghPath,
      `repos/${owner}/${name}/issues/${number}/comments?per_page=10&sort=created&direction=desc`,
      timeoutMs,
    ) as Promise<RestComment[]>,
    ghApiJson(
      ghPath,
      `repos/${owner}/${name}/pulls/${number}/comments?per_page=10&sort=created&direction=desc`,
      timeoutMs,
    ) as Promise<RestComment[]>,
    ghApiJson(
      ghPath,
      `repos/${owner}/${name}/pulls/${number}/reviews?per_page=5`,
      timeoutMs,
    ) as Promise<RestReview[]>,
  ])
  return conversationFromRest(issueComments, reviewComments, reviews)
}
