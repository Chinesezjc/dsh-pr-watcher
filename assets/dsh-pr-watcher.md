# dsh-pr-watcher

Use the `dsh-pr-watcher` tools whenever you need to know whether a GitHub pull
request reached a given state — CI checks settled green, review threads
resolved, mergeable, approved, merged, or closed — or when a branch head (for
example `master`) advances. The host service polls the watched targets through
the `gh` CLI on a fixed interval and delivers notifications to your session:
ONE notification when a watch's conditions flip to satisfied, and — by default
— a notification for every observed change. You do not need to poll
`gh pr view` / `gh pr checks` in a loop.

## Tools

- `pr_status` — one-shot status of a pull request or a branch head. Pass `repo`
  (`owner/name`) and exactly one of `number` (pull request) or `branch`. For a
  PR it returns the CI check counts (failed/pending/total), unresolved review
  threads, mergeable state, review decision, head ref, activity counts, and the
  recent conversation: issue comments, review summaries, and inline review
  comments with author, time, and body (newest first). For a branch it returns
  the head commit oid, its commit date, and the branch's commit count.
  Read-only; registers nothing. Use this when you just want a single snapshot,
  not a watch.
- `pr_watch` — register a watch on a pull request or a branch head.
  Notifications go to THIS session. Pass `repo` and exactly one of `number` or
  `branch`; optionally `id` (default `owner/name#number` for a PR watch and
  `owner/name@branch` for a branch watch), `conditions`, `notifyChanges`
  (default true — change notifications, including comments with content, are on
  unless you pass false), `ignoreOwnComments` (default true — comments from the
  authenticated `gh` account are not treated as changes), and `delivery`. The
  first poll happens within one poll interval (default 60s).
- `pr_watch_list` — list active watches: target (PR or branch), selected
  conditions, whether satisfied, whether already notified, last snapshot
  summary or fetch error, last poll time. Check this instead of re-querying the
  target yourself.
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
| `mergeable` | GitHub reports `MERGEABLE` (see the note on `UNKNOWN` below) |
| `conflicted` | GitHub reports `CONFLICTING` (the PR needs a merge-forward against its base) |
| `reviewApproved` | review decision is `APPROVED` |
| `merged` | PR state is `MERGED` |
| `closed` | PR state is `CLOSED` |

GitHub computes a pull request's mergeability asynchronously. While that
computation is queued the API answers `UNKNOWN` (or nothing), which is the
absence of an answer rather than a state: the watchdog keeps the last definite
`MERGEABLE`/`CONFLICTING` value, so a queued recompute neither notifies as a
change nor flips `mergeable`/`conflicted`. A `MERGEABLE -> UNKNOWN` line in an
old notification is that transient; re-read the authoritative value with
`pr_status` or `gh pr view <n> --json mergeable` and take no action on it.

The default selection is the "ready" set: `checksPassed`, `threadsResolved`,
`mergeable`, `reviewApproved`. `merged`+`closed`, `checksPassed`+`checksFailed`,
and `mergeable`+`conflicted` are mutually exclusive pairs and cannot be
combined. `checksPassed` means fully settled (failed=0 AND pending=0) —
pending checks do NOT count as satisfied. Use `checksFailed` alone for a "CI
broke, intervene now" trigger, and `conflicted` alone to be notified the
moment a merge-forward against the base becomes necessary.

## Change notifications

Change notifications are ON by default: every watch delivers a notification
whenever a poll observes new commits, new reviews, new review threads, new
review comments, new issue comments, a **check-run state transition**
(pending → failed / passed), a **mergeable-state transition** (e.g.
`MERGEABLE -> CONFLICTING`), or a new conversation comment — so reviewer
comments always reach you with their content. Check deltas are signed and the
newly failed check names are included, so a CI failure surfaces as
`changes: checks: +1 failed, -1 pending, newly failed: lint`. Newly arrived
comments are embedded with their author, time, and body under a `new
comments:` block, so a woken agent knows what the reviewer said without
another query. The comment content is only fetched when a comment count
changed, so quiet polls cost nothing extra. A poll that both satisfies the
conditions and observes changes sends ONE combined message.

Pass `notifyChanges: false` for a pure ready-condition watch that only fires
the single satisfied notification and ignores everything else until then.

## Own comments are not changes

Every comment you post through `gh` appears in the PR conversation on the next
poll. Counting your own replies as changes would notify this session about what
it just did, so `pr_watch` filters them out by default (`ignoreOwnComments`,
default true): a poll whose only news is a comment from the authenticated `gh`
account produces no notification at all, and when a notification fires for
another reason the comment counts in it exclude your own comments.

Two consequences to keep in mind:

- The filter matches the `gh` ACCOUNT, not the process that wrote the comment.
  A comment typed on github.com while logged in as that same account is
  filtered too. Pass `ignoreOwnComments: false` on the watch (or set
  `ignoreOwnComments: false` in the plugin config) when every comment must
  count, for example when the operator replies in the web UI and expects the
  watch to wake you.
- When a notification fires for another reason and filtered comments were also
  present, it says so: `note: 2 new comments from a filtered author were
  ignored`. Treat that line as "there is more in the PR conversation than this
  message shows" and call `pr_status` when it matters.

`Config.ignoreCommentAuthors` lists further logins to filter for every watch,
independently of `ignoreOwnComments`. `pr_status` never filters: it always
shows the full conversation window.

## Branch watches

`pr_watch(repo=..., branch="master")` watches a branch head instead of a pull
request. The conditions table does not apply: a branch watch takes NO
conditions (`conditions` must be omitted or empty) and never satisfies — it is
a pure change watch that notifies every time the head commit moves, with the
new oid, its commit date, and the commit-count delta:

```
PR watch "example-org/example-repo@master" changed: example-org/example-repo@master (https://.../tree/master)
branch: master
head: 1a2b3c4d... (2026-09-04T01:00:00Z)
commits: 128
changes: branch advanced 9f8e7d6c -> 1a2b3c4d, +2 commits
```

Use a branch watch to notice that a base branch moved under you — a
merge-forward into `master`, or a stack member's base advancing — instead of
polling `git fetch` / `gh api` in a loop. A branch watch is silent until the
head actually changes, so registering one is cheap. `notifyChanges: false` is
rejected on a branch watch: with no conditions to satisfy it would be a watch
that can never notify.

## Delivery

Each notification CUTS INTO this session by default: the default delivery mode
is `steer`, which interrupts at the nearest step boundary of a running turn
(and wakes an idle-loaded session), so a satisfied or changed watch reaches
you immediately even mid-task. Pass `delivery` to override:

- `steer` — cuts into the nearest step boundary of a running turn; wakes an
  idle session (default).
- `followup` — queues the notification as its own turn after current work;
  wakes an idle session.
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
  (change notifications are on by default). Every check-run flip
  (pending → failed/passed) delivers a change notification naming the newly
  failed checks, and the final all-green state delivers the satisfied
  notification.
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

A transient `gh` failure (network, GraphQL error) marks the watch's
`lastError`, keeps the previous snapshot — it does NOT look like a change —
and backs off that watch exponentially (30s doubling to a 10min ceiling). A PR
or repository that does not exist reports `not found` and keeps the watch in
the error state; call `pr_status` to re-check, or remove the watch.

A rate limit is handled service-wide: one query is issued per distinct target
(watches naming the same pull request or branch head share it) with a 250ms gap
between queries so a cycle never bursts its requests, and a rate-limit failure
pauses EVERY watch instead of only the target that failed. The pause follows
what GitHub reported: the secondary (abuse) limit pauses 60s doubling to a 5min
ceiling, an exhausted GraphQL point budget pauses 120s doubling to a 30min
ceiling. While paused, `pr_watch_list` keeps showing the rate-limit
`lastError` and no snapshot updates arrive; polling resumes on its own once the
pause expires, and a successful poll ends it early. GitHub's secondary rate
limit does not appear in `gh api rate_limit`, so a pause can be the only
symptom. A large watch set can outspend the account-wide point budget (shared
with every other client on the same `gh` account); `maxPointsPerHour` (default
2400) stretches the effective interval to keep this service inside its share,
and `pr_watch_list` shows each watch's last poll time, so a stalled cycle is
visible in the listing.

## Operational notes

- Runtime watches are ephemeral unless the plugin config sets `stateFile`:
  after a process restart they are gone, so re-register with `pr_watch` (or
  configure a `stateFile` so the plugin restores them itself).
- Comment edits and deletions are not detected; only newly added comments
  surface. The conversation window keeps the newest 15 comments.
- A satisfied watch is fully silent afterwards — one phase, one notification.
- Check contexts and review threads are fetched in windows of 100. When a PR
  has more, the notification and `pr_status` carry a `note:` line with the
  real total, so you can see the counts above are partial (the all-clear
  conditions fail closed on a truncated window — hidden failures or
  unresolved threads never read as green). If the partial view matters, query
  the exhaustive state yourself (e.g. `gh pr checks` / the REST comments
  endpoints).

## Requirements

The profile host must have a `gh` CLI authenticated for the watched
repositories (`gh auth login`, or `GH_TOKEN`/`GITHUB_TOKEN` on servers). The
plugin stores no token itself. Static watches configured in the plugin config
`watches` list notify the configured target session; runtime `pr_watch` calls
always target the calling session.
