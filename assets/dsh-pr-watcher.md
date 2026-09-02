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
  review threads, mergeable state, review decision, head ref, and activity
  counts. Read-only; registers nothing. Use this when you just want a single
  snapshot, not a watch.
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
| `reviewApproved` | review decision is `APPROVED` |
| `merged` | PR state is `MERGED` |
| `closed` | PR state is `CLOSED` |

The default selection is the "ready" set: `checksPassed`, `threadsResolved`,
`mergeable`, `reviewApproved`. `merged` and `closed` are mutually exclusive and
cannot be combined; so are `checksPassed` and `checksFailed`. `checksPassed`
means fully settled (failed=0 AND pending=0) — pending checks do NOT count as
satisfied. Use `checksFailed` alone for a "CI broke, intervene now" trigger:
the watch satisfies the moment any check fails.

## Change notifications

With `notifyChanges: true`, the watch also delivers a change notification
whenever a poll observes new commits, new reviews, new review threads, new
review comments, new issue comments, or a **check-run state transition**
(pending → failed / passed). Check deltas are signed and the newly failed
check names are included, so a CI failure surfaces as
`changes: checks: +1 failed, -1 pending, newly failed: lint`. A poll that both
satisfies the conditions and observes changes sends ONE combined message.

## Delivery

Notifications reach this session's inbox. The default delivery mode is
`inject` (seeds context without waking an idle agent); pass `delivery` to
override:

- `followup` — queues the notification as its own turn after current work.
- `steer` — cuts into the nearest step boundary; use for urgent state changes.
- `inject` — writes the notification into context without waking the agent.

Waking a persisted (not running) session is OFF by default, so a watch whose
target session is not live does not deliver. Sessions owned by a subagent are
refused by design.

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
and lists the deltas, e.g. `changes: +1 commit, +2 review comments`.

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
