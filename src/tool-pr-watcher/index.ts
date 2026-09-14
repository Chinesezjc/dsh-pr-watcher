/**
 * Model-facing tools for `dsh-pr-watcher`: `pr_status` queries one pull
 * request's current status, `pr_watch` registers a watch that notifies the
 * calling session when its conditions are met (or when the PR changes),
 * `pr_watch_list` lists active watches, and `pr_watch_remove` stops one.
 *
 * The tools consume the host-plane `prWatcher` service and publish nothing
 * themselves, so this row sits as an ordinary tool plugin while the service it
 * reaches stays host-side (the same split `tool-interconnect` uses).
 * @module dsh-pr-watcher
 */

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Activates the `Context.prWatcher` merge declared by the pr-watcher service plugin.
import type {} from '../pr-watcher/index.ts'
import { renderCommentLine } from '../pr-watcher/conditions.ts'
import {
  CONDITION_NAMES,
  DEFAULT_CONDITIONS,
  type DeliveryMode,
  type WatchSnapshot,
} from '../pr-watcher/types.ts'

/** Services required before the tools can register. */
export const inject = ['prWatcher', 'tools']

const CONDITION_ENUM = [...CONDITION_NAMES]
/** Comment entries shown in the pr_status text rendering. */
const STATUS_CONVERSATION_LIMIT = 8

/** Compact text summary of one snapshot, shared by several renders. */
function snapshotLines(snapshot: WatchSnapshot): string[] {
  if (snapshot.kind === 'branch') {
    return [
      `${snapshot.repo}@${snapshot.branch}`,
      `head: ${snapshot.headOid}${snapshot.committedDate === '' ? '' : ` (${snapshot.committedDate})`}`,
      `commits: ${snapshot.commits}`,
      `url: ${snapshot.url}`,
    ]
  }
  const lines: string[] = [
    `${snapshot.repo}#${snapshot.number} ${snapshot.state}${snapshot.merged ? ' (merged)' : ''}`,
    `checks: ${snapshot.checks.failed} failed, ${snapshot.checks.pending} pending of ${snapshot.checkContexts}`,
    `review threads: ${snapshot.unresolvedThreads} unresolved of ${snapshot.reviewThreads}`,
  ]
  if (snapshot.checksTruncated && snapshot.checkContexts > snapshot.checks.total) {
    lines.push(`note: ${snapshot.checkContexts} check contexts in total; only the newest ${snapshot.checks.total} were fetched, so the check counts above are partial`)
  }
  if (snapshot.threadsTruncated) {
    lines.push(`note: ${snapshot.reviewThreads} review threads in total; only the newest 100 were fetched, so the unresolved count above is partial`)
  }
  if (snapshot.failedChecks.length > 0) lines.push(`failed checks: ${snapshot.failedChecks.join(', ')}`)
  if (snapshot.mergeable !== null) lines.push(`mergeable: ${snapshot.mergeable}`)
  if (snapshot.reviewDecision !== null) lines.push(`review decision: ${snapshot.reviewDecision}`)
  lines.push(`head: ${snapshot.headRefName} @ ${snapshot.headRefOid}`)
  if (snapshot.conversation.length > 0) {
    lines.push('conversation (newest first):')
    for (const entry of snapshot.conversation.slice(0, STATUS_CONVERSATION_LIMIT)) {
      lines.push(renderCommentLine(entry))
    }
    const hidden = snapshot.conversation.length - STATUS_CONVERSATION_LIMIT
    if (hidden > 0) lines.push(`+${hidden} more`)
  }
  return lines
}

function deliveryMode(mode: DeliveryMode | undefined, fallback: string): string {
  return mode ?? fallback
}

/**
 * Register the tool surfaces. Registration is idempotent per fiber; the tools
 * unregister with the owning fiber.
 * @param ctx - connection context carrying the prWatcher service and the tool registry.
 */
export function apply(ctx: Context): void {
  const prWatcher = ctx.prWatcher

  ctx.tools.register(defineTool({
    name: 'pr_status',
    description: 'Query the current status of one GitHub pull request through the gh CLI: CI check counts '
      + '(failed/pending/total), unresolved review threads, mergeable state, review decision, head ref, '
      + 'activity counts, and the recent conversation (issue comments, review summaries, and inline review '
      + 'comments with author, time, and body). Pass branch instead of number to query a branch head '
      + '(head commit, commit count, last commit date). Read-only; does not register a watch. Use pr_watch '
      + 'to be notified when conditions are met instead of polling manually.',
    parameters: {
      repo: {
        type: 'string',
        required: true,
        description: 'Repository as `owner/name`, e.g. `<owner>/<repo>`.',
      },
      number: {
        type: 'number',
        description: 'Pull request number; provide this or branch.',
      },
      branch: {
        type: 'string',
        description: 'Branch name whose head to query (e.g. `master`); provide this or number.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          snapshot: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true },
              repo: { type: 'string', required: true },
              number: { type: 'number' },
              branch: { type: 'string' },
              url: { type: 'string' },
              headOid: { type: 'string' },
              committedDate: { type: 'string' },
              state: { type: 'string' },
              merged: { type: 'boolean' },
              mergeable: { type: 'string' },
              reviewDecision: { type: 'string' },
              headRefName: { type: 'string' },
              headRefOid: { type: 'string' },
              commits: { type: 'number' },
              reviews: { type: 'number' },
              reviewThreads: { type: 'number' },
              reviewComments: { type: 'number' },
              issueComments: { type: 'number' },
              unresolvedThreads: { type: 'number' },
              checksTruncated: { type: 'boolean' },
              threadsTruncated: { type: 'boolean' },
              checkContexts: { type: 'number' },
              failedChecks: { type: 'array', items: { type: 'string' } },
              conversation: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    key: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    author: { type: 'string', required: true },
                    createdAt: { type: 'string', required: true },
                    body: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    path: { type: 'string' },
                  },
                },
              },
              checks: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  total: { type: 'number', required: true },
                  passed: { type: 'number', required: true },
                  failed: { type: 'number', required: true },
                  pending: { type: 'number', required: true },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.ok === false) {
          return [{ type: 'text', text: `pr_status: ${value.reason ?? 'unknown error'}` }]
        }
        if (value.snapshot === undefined) {
          return [{ type: 'text', text: 'pr_status: no snapshot' }]
        }
        const snapshot = value.snapshot as unknown as WatchSnapshot
        return [{ type: 'text', text: snapshotLines(snapshot).join('\n') }]
      },
    },
    async execute(args) {
      if ((args.number === undefined) === (args.branch === undefined)) {
        return { ok: false, reason: 'provide exactly one of number (pull request) or branch' } as never
      }
      // The service's QueryResult union is structurally wider than the declared
      // output schema (nullable mergeable/reviewDecision); the schema is the
      // contract the model sees, so the cast is deliberate.
      return (args.branch === undefined
        ? prWatcher.check(args.repo, args.number as number)
        : prWatcher.checkBranch(args.repo, args.branch)) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pr_watch',
    description: 'Register a watch on one GitHub pull request, or on a branch head. The service polls the '
      + 'target on a configurable interval and delivers one notification to THIS session when the selected '
      + 'conditions are all met (edge-triggered: only on the flip from not-met to met), and — by default — a '
      + 'notification for every observed change (new comments with content, new commits, check-run or '
      + 'mergeable-state transitions) before the conditions are met. A branch watch (pass branch instead of '
      + 'number) takes no conditions and notifies every time the branch head advances; use it to observe '
      + 'master or a base branch moving. The default delivery cuts into this session (steer); pass delivery '
      + 'followup to queue behind current work, or inject to only seed context without waking. Run '
      + 'pr_watch_list to see active watches and pr_watch_remove to stop one.',
    parameters: {
      repo: {
        type: 'string',
        required: true,
        description: 'Repository as `owner/name`, e.g. `<owner>/<repo>`.',
      },
      number: {
        type: 'number',
        description: 'Pull request number; provide this or branch.',
      },
      branch: {
        type: 'string',
        description: 'Branch name whose head is watched (e.g. `master`); provide this or number. '
          + 'Branch watches take no conditions and notify on every head advance.',
      },
      id: {
        type: 'string',
        description: 'Watch id; defaults to `<repo>#<number>` for a PR watch and `<repo>@<branch>` for a '
          + 'branch watch. Must be unique among active watches.',
      },
      conditions: {
        type: 'array',
        items: { type: 'string', enum: CONDITION_ENUM },
        description: 'Conditions ANDed for the satisfied notification. Valid values: '
          + CONDITION_ENUM.join(', ')
          + '. Defaults to the ready set: checksPassed, threadsResolved, mergeable, reviewApproved; must be '
          + 'empty for a branch watch. '
          + 'Use checksFailed alone to be notified once when CI turns red, and conflicted alone to be '
          + 'notified the moment a merge-forward against the base becomes necessary. '
          + 'merged+closed, checksPassed+checksFailed, and mergeable+conflicted are contradictory '
          + 'pairs and are rejected.',
      },
      notifyChanges: {
        type: 'boolean',
        description: 'Notify on observed changes (new comments with content, new commits, check-run and '
          + 'mergeable-state transitions) before the conditions are met. Default true; pass false for a '
          + 'pure ready-condition watch that only fires the single satisfied notification.',
      },
      delivery: {
        type: 'string',
        enum: ['followup', 'steer', 'inject'],
        description: 'How the notification reaches this session. `steer` (default) cuts into the nearest '
          + 'step boundary of a running turn, so the notification interrupts current work; `followup` queues '
          + 'a turn behind current work (both wake an idle-loaded session); `inject` only seeds context '
          + 'without waking, so it may sit unread.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          id: { type: 'string' },
          repo: { type: 'string' },
          number: { type: 'number' },
          branch: { type: 'string' },
          conditions: { type: 'array', items: { type: 'string' } },
          notifyChanges: { type: 'boolean' },
          delivery: { type: 'string' },
          sessionId: { type: 'string' },
        },
      },
      render: (args, value) => {
        if (value.ok === false) {
          return [{ type: 'text', text: `pr_watch: not registered: ${value.reason ?? 'unknown error'}` }]
        }
        const mode = deliveryMode(value.delivery as DeliveryMode | undefined, 'steer (default, cuts in)')
        const conditions = (value.conditions as string[] | undefined) ?? []
        const target = value.branch === undefined ? `${value.repo}#${value.number}` : `${value.repo}@${value.branch}`
        return [{
          type: 'text',
          text: `watch "${value.id ?? args.id}" registered: ${target}; `
            + `conditions: ${conditions.length === 0 ? 'none (notifies on every change)' : conditions.join(', ')}; `
            + `changes: ${value.notifyChanges ? 'on' : 'off'}; `
            + `notifying session ${value.sessionId} via ${mode}. The first poll happens within one poll interval.`,
        }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) {
        return { ok: false, reason: 'no agent session context for this tool call' }
      }
      if ((args.number === undefined) === (args.branch === undefined)) {
        return { ok: false, reason: 'provide exactly one of number (pull request) or branch' }
      }
      const isBranch = args.branch !== undefined
      const id = args.id ?? (isBranch ? `${args.repo}@${args.branch}` : `${args.repo}#${args.number}`)
      const conditions = args.conditions ?? (isBranch ? [] : [...DEFAULT_CONDITIONS])
      // Change notifications are on by default: a watch exists to keep this
      // session posted on the target (new comments, commits, CI and mergeable
      // transitions). Pass false for a pure ready-condition watch that only
      // fires once.
      const notifyChanges = args.notifyChanges ?? true
      const delivery = args.delivery as DeliveryMode | undefined
      const targetSessionId = String(sessionId)
      const result = prWatcher.watch({
        id,
        repo: args.repo,
        ...(isBranch ? { branch: args.branch as string } : { number: args.number as number }),
        conditions: conditions as never,
        notifyChanges,
        target: {
          sessionId: targetSessionId,
          ...(delivery === undefined ? {} : { delivery }),
        },
      })
      if (!result.ok) return result
      return {
        ok: true,
        id: result.id,
        repo: args.repo,
        ...(isBranch ? { branch: args.branch } : { number: args.number }),
        conditions,
        notifyChanges,
        ...(delivery === undefined ? {} : { delivery }),
        sessionId: targetSessionId,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pr_watch_list',
    description: 'List every active watch: id, repository, target (PR number or branch), selected conditions, '
      + 'whether the conditions currently hold, whether the satisfied notification was already delivered, the '
      + 'target session, the last snapshot summary (or the last fetch error), and the last poll time.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          watches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                repo: { type: 'string', required: true },
                number: { type: 'number' },
                branch: { type: 'string' },
                target: { type: 'string', required: true },
                conditions: { type: 'array', items: { type: 'string' }, required: true },
                satisfied: { type: 'boolean', required: true },
                notified: { type: 'boolean', required: true },
                notifyChanges: { type: 'boolean', required: true },
                sessionId: { type: 'string', required: true },
                delivery: { type: 'string' },
                state: { type: 'string' },
                checks: { type: 'string' },
                unresolvedThreads: { type: 'number' },
                lastError: { type: 'string' },
                lastPolledAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const watches = value.watches ?? []
        if (watches.length === 0) {
          return [{ type: 'text', text: 'no active watches' }]
        }
        const lines = watches.map((watch) => {
          const state = watch.state === undefined ? 'no snapshot yet' : watch.state
          const checks = watch.checks === undefined ? '' : `; ${watch.checks}`
          const error = watch.lastError === undefined ? '' : `; last error: ${watch.lastError}`
          return `${watch.id}: ${watch.target} ${state}${checks}`
            + ` (satisfied=${watch.satisfied}, notified=${watch.notified}, changes=${watch.notifyChanges})`
            + ` -> ${watch.sessionId}${error}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      return {
        watches: prWatcher.list().map((watch) => {
          const snapshot = watch.snapshot
          return {
            id: watch.id,
            repo: watch.repo,
            ...(watch.number === undefined ? { branch: watch.branch } : { number: watch.number }),
            target: watch.number === undefined ? `${watch.repo}@${watch.branch}` : `${watch.repo}#${watch.number}`,
            conditions: [...watch.conditions],
            satisfied: watch.satisfied,
            notified: watch.notified,
            notifyChanges: watch.notifyChanges,
            sessionId: watch.target.sessionId,
            ...(watch.target.delivery === undefined ? {} : { delivery: watch.target.delivery }),
            ...(snapshot === undefined ? {} : snapshot.kind === 'branch'
              ? {
                state: `branch ${snapshot.branch}`,
                checks: `head ${snapshot.headOid.slice(0, 8)} of ${snapshot.commits} commits`,
              }
              : {
                state: snapshot.state,
                checks: `${snapshot.checks.failed} failed, ${snapshot.checks.pending} pending of ${snapshot.checks.total}`,
                unresolvedThreads: snapshot.unresolvedThreads,
              }),
            ...(watch.lastError === undefined ? {} : { lastError: watch.lastError }),
            ...(watch.lastPolledAt === undefined ? {} : { lastPolledAt: watch.lastPolledAt }),
          }
        }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pr_watch_remove',
    description: 'Stop a watch by id (pull request or branch). Only runtime-registered watches can be '
      + 'removed; static watches configured in the plugin config are not removable through this tool. See '
      + 'pr_watch_list for ids.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Watch id to remove.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          id: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.ok === false) {
          return [{ type: 'text', text: `pr_watch_remove: ${value.reason ?? 'unknown error'}` }]
        }
        return [{ type: 'text', text: `watch "${value.id}" removed` }]
      },
    },
    async execute(args) {
      const removed = prWatcher.unwatch(args.id)
      if (!removed) return { ok: false, id: args.id, reason: `no watch with id "${args.id}"` }
      return { ok: true, id: args.id }
    },
  }))
}
