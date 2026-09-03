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
import { CONDITION_NAMES, DEFAULT_CONDITIONS, type DeliveryMode, type PrSnapshot } from '../pr-watcher/types.ts'

/** Services required before the tools can register. */
export const inject = ['prWatcher', 'tools']

const CONDITION_ENUM = [...CONDITION_NAMES]

/** Compact text summary of one snapshot, shared by several renders. */
function snapshotLines(snapshot: PrSnapshot): string[] {
  const lines: string[] = [
    `${snapshot.repo}#${snapshot.number} ${snapshot.state}${snapshot.merged ? ' (merged)' : ''}`,
    `checks: ${snapshot.checks.failed} failed, ${snapshot.checks.pending} pending of ${snapshot.checks.total}`,
    `review threads: ${snapshot.unresolvedThreads} unresolved of ${snapshot.reviewThreads}`,
  ]
  if (snapshot.failedChecks.length > 0) lines.push(`failed checks: ${snapshot.failedChecks.join(', ')}`)
  if (snapshot.mergeable !== null) lines.push(`mergeable: ${snapshot.mergeable}`)
  if (snapshot.reviewDecision !== null) lines.push(`review decision: ${snapshot.reviewDecision}`)
  lines.push(`head: ${snapshot.headRefName} @ ${snapshot.headRefOid}`)
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
      + '(failed/pending/total), unresolved review threads, mergeable state, review decision, head ref, and '
      + 'activity counts. Read-only; does not register a watch. Use pr_watch to be notified when conditions '
      + 'are met instead of polling manually.',
    parameters: {
      repo: {
        type: 'string',
        required: true,
        description: 'Repository as `owner/name`, e.g. `<owner>/<repo>`.',
      },
      number: {
        type: 'number',
        required: true,
        description: 'Pull request number.',
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
              repo: { type: 'string', required: true },
              number: { type: 'number', required: true },
              url: { type: 'string' },
              state: { type: 'string', required: true },
              merged: { type: 'boolean', required: true },
              mergeable: { type: 'string' },
              reviewDecision: { type: 'string' },
              headRefName: { type: 'string' },
              headRefOid: { type: 'string' },
              commits: { type: 'number', required: true },
              reviews: { type: 'number', required: true },
              reviewThreads: { type: 'number', required: true },
              reviewComments: { type: 'number', required: true },
              issueComments: { type: 'number', required: true },
              unresolvedThreads: { type: 'number', required: true },
              failedChecks: { type: 'array', items: { type: 'string' }, required: true },
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
        const snapshot = value.snapshot as unknown as PrSnapshot
        return [{ type: 'text', text: snapshotLines(snapshot).join('\n') }]
      },
    },
    async execute(args) {
      // The service's QueryResult union is structurally wider than the declared
      // output schema (nullable mergeable/reviewDecision); the schema is the
      // contract the model sees, so the cast is deliberate.
      return prWatcher.check(args.repo, args.number) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pr_watch',
    description: 'Register a watch on one GitHub pull request. The service polls the PR on a configurable '
      + 'interval and delivers one notification that WAKES this session when the selected conditions are all '
      + 'met (edge-triggered: only on the flip from not-met to met). With notifyChanges, it also notifies on '
      + 'observed changes (new commits, new reviews, new comments, check-run or mergeable-state transitions) '
      + 'before the conditions are met. The default delivery wakes this session (followup); pass delivery '
      + 'inject to only seed context without waking. Run pr_watch_list to see active watches and '
      + 'pr_watch_remove to stop one.',
    parameters: {
      repo: {
        type: 'string',
        required: true,
        description: 'Repository as `owner/name`, e.g. `<owner>/<repo>`.',
      },
      number: {
        type: 'number',
        required: true,
        description: 'Pull request number.',
      },
      id: {
        type: 'string',
        description: 'Watch id; defaults to `<repo>#<number>`. Must be unique among active watches.',
      },
      conditions: {
        type: 'array',
        items: { type: 'string', enum: CONDITION_ENUM },
        description: 'Conditions ANDed for the satisfied notification. Valid values: '
          + CONDITION_ENUM.join(', ')
          + '. Defaults to the ready set: checksPassed, threadsResolved, mergeable, reviewApproved. '
          + 'Use checksFailed alone to be notified once when CI turns red, and conflicted alone to be '
          + 'notified the moment a merge-forward against the base becomes necessary. '
          + 'merged+closed, checksPassed+checksFailed, and mergeable+conflicted are contradictory '
          + 'pairs and are rejected.',
      },
      notifyChanges: {
        type: 'boolean',
        description: 'Also notify on observed changes before the conditions are met. Default false.',
      },
      delivery: {
        type: 'string',
        enum: ['followup', 'steer', 'inject'],
        description: 'How the notification wakes this session. `followup` (default) queues a turn behind '
          + 'current work and wakes an idle-loaded session; `steer` cuts into the nearest step boundary of a '
          + 'running turn; `inject` only seeds context without waking, so it may sit unread.',
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
        const mode = deliveryMode(value.delivery as DeliveryMode | undefined, 'followup (default, wakes)')
        const conditions = (value.conditions as string[] | undefined) ?? []
        return [{
          type: 'text',
          text: `watch "${value.id ?? args.id}" registered: ${value.repo}#${value.number}; `
            + `conditions: ${conditions.join(', ')}; changes: ${value.notifyChanges ? 'on' : 'off'}; `
            + `notifying session ${value.sessionId} via ${mode}. The first poll happens within one poll interval.`,
        }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) {
        return { ok: false, reason: 'no agent session context for this tool call' }
      }
      const id = args.id ?? `${args.repo}#${args.number}`
      const conditions = args.conditions ?? [...DEFAULT_CONDITIONS]
      const notifyChanges = args.notifyChanges ?? false
      const delivery = args.delivery as DeliveryMode | undefined
      const targetSessionId = String(sessionId)
      const result = prWatcher.watch({
        id,
        repo: args.repo,
        number: args.number,
        conditions,
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
        number: args.number,
        conditions,
        notifyChanges,
        ...(delivery === undefined ? {} : { delivery }),
        sessionId: targetSessionId,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pr_watch_list',
    description: 'List every active PR watch: id, repository, PR number, selected conditions, whether the '
      + 'conditions currently hold, whether the satisfied notification was already delivered, the target '
      + 'session, the last snapshot summary (or the last fetch error), and the last poll time.',
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
                number: { type: 'number', required: true },
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
          return [{ type: 'text', text: 'no active PR watches' }]
        }
        const lines = watches.map((watch) => {
          const state = watch.state === undefined ? 'no snapshot yet' : watch.state
          const checks = watch.checks === undefined ? '' : `; ${watch.checks}`
          const error = watch.lastError === undefined ? '' : `; last error: ${watch.lastError}`
          return `${watch.id}: ${watch.repo}#${watch.number} ${state}${checks}`
            + ` (satisfied=${watch.satisfied}, notified=${watch.notified}, changes=${watch.notifyChanges})`
            + ` -> ${watch.sessionId}${error}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      return {
        watches: prWatcher.list().map((watch) => ({
          id: watch.id,
          repo: watch.repo,
          number: watch.number,
          conditions: [...watch.conditions],
          satisfied: watch.satisfied,
          notified: watch.notified,
          notifyChanges: watch.notifyChanges,
          sessionId: watch.target.sessionId,
          ...(watch.target.delivery === undefined ? {} : { delivery: watch.target.delivery }),
          ...(watch.snapshot === undefined ? {} : {
            state: watch.snapshot.state,
            checks: `${watch.snapshot.checks.failed} failed, ${watch.snapshot.checks.pending} pending of ${watch.snapshot.checks.total}`,
            unresolvedThreads: watch.snapshot.unresolvedThreads,
          }),
          ...(watch.lastError === undefined ? {} : { lastError: watch.lastError }),
          ...(watch.lastPolledAt === undefined ? {} : { lastPolledAt: watch.lastPolledAt }),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pr_watch_remove',
    description: 'Stop a PR watch by id. Only runtime-registered watches can be removed; static watches '
      + 'configured in the plugin config are not removable through this tool. See pr_watch_list for ids.',
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
