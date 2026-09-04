# dsh-pr-watcher

Use the `dsh-pr-watcher` tools whenever you need to know whether a GitHub pull
request reached a given state — CI checks settled green, review threads
resolved, mergeable, approved, merged, or closed. The host service polls PRs
through the `gh` CLI on a fixed interval and delivers ONE notification to your
session when the conditions flip to satisfied, so you do not need to poll
`gh pr view` / `gh pr checks` in a loop.

## Tools

- `pr_status` — one-shot status of a pull request. Pass `repo` (`owner/name`)
  and `number`. Returns the CI check counts (failed/pending/total), unresolved
  review threads, mergeable state, review decision, head ref, activity counts,
  and the recent conversation: issue comments, review summaries, and inline
  review comments with author, time, and body (newest first). Read-only;
  registers nothing. Use this when you just want a single snapshot, not a
  watch.
- `pr_watch` — register a watch on a pull request. Notifications go to THIS
  session. Pass `repo` and `number`; optionally `id` (default
  `owner/name#number`), `conditions`, `notifyChanges`, and `delivery`. The
  first poll happens within one poll interval (default 60s).
- `pr_watch_list` — list active watches: target PR, selected conditions,
  whether satisfied, whether already notified, last snapshot summary or fetch
  error, last poll time. Check this instead of re-querying the PR yourself.
- `pr_watch_remove` — stop a runtime-registered watch by `id`. Static watches
  from the plugin config are not removable through this tool.

## Conditions

A watch is SATISFIED when all its selected conditions hold. The satisfaction
notification is edge-triggered: delivered exactly once, on the flip from
not-satisfied to satisfied, then never again for that watch.

| Condition | Holds when |
| --- | --- |
| `checksPassed` | no failed and no pending checks (fully settled; a PR with no checks satisfies vacuously) |
| `checksFailed` | at least one check failed (CI is red) |
| `threadsResolved` | no unresolved review threads |
| `mergeable` | GitHub reports `MERGEABLE` |
| `conflicted` | GitHub reports `CONFLICTING` (the PR needs a merge-forward against its base) |
| `reviewApproved` | review decision is `APPROVED` |
| `merged` | PR state is `MERGED` |
| `closed` | PR state is `CLOSED` |

The default selection is the "ready" set: `checksPassed`, `threadsResolved`,
`mergeable`, `reviewApproved`. `merged`+`closed`, `checksPassed`+`checksFailed`,
and `mergeable`+`conflicted` are mutually exclusive pairs and cannot be
combined. `checksPassed` means fully settled (failed=0 AND pending=0) —
pending checks do NOT count as satisfied. Use `checksFailed` alone for a "CI
broke, intervene now" trigger, and `conflicted` alone to be notified the
moment a merge-forward against the base becomes necessary.

## Change notifications

With `notifyChanges: true`, the watch also delivers a change notification
whenever a poll observes new commits, new reviews, new review threads, new
review comments, new issue comments, a **check-run state transition**
(pending → failed / passed), a **mergeable-state transition** (e.g.
`MERGEABLE -> CONFLICTING`), or a new conversation comment. Check deltas are
signed and the newly failed check names are included, so a CI failure
surfaces as `changes: checks: +1 failed, -1 pending, newly failed: lint`.
Newly arrived comments are embedded with their author, time, and body under a
`new comments:` block, so a woken agent knows what the reviewer said without
another query. The comment content is only fetched when a comment count
changed, so quiet polls cost nothing extra. A poll that both satisfies the
conditions and observes changes sends ONE combined message.

## Delivery

Each notification WAKES this session by default: the default delivery mode is
`followup`, which queues the notification as its own turn after current work
and wakes an idle-loaded session. Pass `delivery` to override:

- `followup` — queues the notification as its own turn and wakes an idle
  session (default).
- `steer` — cuts into the nearest step boundary of a running turn; use for
  urgent state changes.
- `inject` — only writes the notification into context WITHOUT waking the
  agent, so it can sit unread; opt in when you want silent seeding.

Waking a fully unloaded (persisted, not loaded) session is ON by default
(`allowResume: true`): the notification resumes the session with the toolset
its history was produced under. Set `allowResume: false` in the plugin config
to forbid waking. Sessions owned by a subagent are refused by design.

## Recommended workflow

1. Instead of polling a PR yourself, call
   `pr_watch(repo=..., number=..., conditions=[...], notifyChanges=...)` and
   continue with other work.
2. When the notification arrives, read it: it contains the state, check
   counts, unresolved threads, and the conditions-met line. Take the action the
   watch was for (for example, merge the PR when conditions are met, or start
   replying to review threads).
3. If you need a fresh snapshot before acting, call `pr_status(repo=...,
   number=...)`.
4. When the watch has served its purpose, remove it with
   `pr_watch_remove(id=...)`. A satisfied watch stops notifying anyway.

### One watch per phase

A satisfied watch never notifies again. To track a later phase, register a
second watch. For example, after a ready-watch fires (checks green, threads
resolved, mergeable, approved), register a `conditions: ["merged"]` watch to
learn when the PR actually merges.

### CI monitoring patterns

- **Hear about every CI transition, including red**: register the ready set
  with `notifyChanges: true`. Every check-run flip (pending → failed/passed)
  delivers a change notification naming the newly failed checks, and the final
  all-green state delivers the satisfied notification.
- **Only be told when CI breaks**: register `conditions: ["checksFailed"]`.
  The watch satisfies the moment any check fails and notifies once; the
  notification shows the failing check names.

### Stack conflict handling

A `conflicted` notification (or a change notification reading
`mergeable: MERGEABLE -> CONFLICTING`) means the branch fell behind its base
and a merge-forward is required. Resolve it before doing anything else:

1. `git fetch origin` and identify the REAL base head with
   `gh pr view <base-pr> --json headRefOid` — never trust a stale local
   `origin/master`.
2. Merge the base into the current branch: `git merge <base-head>`, resolve the
   conflicts file by file.
3. Commit the resolution. The resolution commit MUST change at least one
   tracked file relative to its parent. An empty commit
   (`git commit --allow-empty`) is never a resolution and is a workflow
   violation — if you have produced one, undo it with `git reset --soft HEAD^`
   and redo the step. Do not use `git commit --no-verify` to bypass checks.
4. Push with a plain `git push` and re-check the mergeable state with
   `pr_status`; the conflict clears only when GitHub recomputes the PR as
   `MERGEABLE`.

## Notification shape

```
PR watch "example-1" conditions met: example-org/example-repo#42 (https://...)
state: OPEN
checks: 0 failed, 0 pending of 32
review threads: 0 unresolved of 12
mergeable: MERGEABLE
review decision: APPROVED
changes: +2 commits, +3 review comments
watch satisfied; notifications for this watch stop here
```

A change-only notification (before satisfaction) says `PR watch "..." changed:`
and lists the deltas, e.g. `changes: +1 commit, +2 review comments`, followed
by the new comments when any arrived:

```
new comments:
[inline src/plugin.ts] reviewer (2026-09-03 02:00:00): this branch looks unreachable / please handle it
[issue] alice: can we also bump the changelog?
```

## Failure behavior

A transient `gh` failure (network, rate limit, GraphQL error) marks the
watch's `lastError` and keeps the previous snapshot — it does NOT look like a
change. The next successful poll clears the error. A PR or repository that
does not exist reports `not found` and keeps the watch in the error state; call
`pr_status` to re-check, or remove the watch.

## Requirements

The profile host must have a `gh` CLI authenticated for the watched
repositories (`gh auth login`, or `GH_TOKEN`/`GITHUB_TOKEN` on servers). The
plugin stores no token itself. Static watches configured in the plugin config
`watches` list notify the configured target session; runtime `pr_watch` calls
always target the calling session.
