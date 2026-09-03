# dsh-pr-watcher

GitHub pull-request watcher for DeepSeek Harness (DSH): a host service that
polls PR status through the `gh` CLI and delivers a notification message into
an agent session when configured conditions are met, plus model-facing tools to
query status and manage watches.

The plugin is a Cordis profile bundle (`dsh.bundle.patch`) in the same shape as
[`dsh-interconnect`](https://github.com/Chinesezjc/dsh-interconnect): a
host-side service plugin plus a model-facing tool plugin, mounted through one
`cordis.patch.yml`.

## Why

An agent supervising pull-request work polls PR state repeatedly: CI check
rollups, unresolved review threads, mergeability, review decisions. That loop
is slow, noisy, and burns model turns. This plugin moves the polling into a
host service with a fixed cadence and pushes a single notification when the
state actually changes: conditions flip to satisfied, or the PR gains new
commits / reviews / comments. The supervising agent registers a watch and then
does other work until the notification arrives.

Repository names are always configuration or tool arguments; no repository
name is baked into this plugin.

## How it works

- A **watch** targets one pull request (`owner/name` + number), selects
  conditions, and names a target session that receives notifications.
- The service polls every watch on `pollIntervalMs` (default 60s) through
  `gh api graphql` with one query per PR. Overlapping poll cycles are skipped,
  never queued.
- A watch is **satisfied** when all its selected conditions hold. The
  satisfaction notification is edge-triggered: delivered exactly once, on the
  flip from not-satisfied to satisfied, then never again for that watch.
- With `notifyChanges: true`, the watch also delivers a change notification
  whenever a poll observes new commits, new reviews, new review threads, new
  review comments, new issue comments, a check-run state transition
  (pending → failed / passed), or a mergeable-state transition (e.g.
  `MERGEABLE -> CONFLICTING`). Check deltas are signed and the newly failed
  check names are included, so a CI failure surfaces as
  `changes: checks: +1 failed, -1 pending, newly failed: lint`. A poll that
  both satisfies the conditions and observes changes sends one combined
  message.
- Notifications WAKES the target session by default: the default delivery
  mode is `followup` (queues its own turn; wakes an idle-loaded session).
  `steer` cuts into the nearest step boundary of a running turn; `inject`
  seeds context without waking and is opt-in. Waking a fully unloaded
  (persisted) session is on by default (`allowResume: true`) and resumes it
  with the toolset its history was produced under. Sessions owned by a
  subagent are refused, matching the host's own handoff fences.

### Conditions

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

`merged`+`closed`, `checksPassed`+`checksFailed`, and `mergeable`+`conflicted`
are mutually exclusive pairs and rejected together. The default selection for
new watches is the "ready" set — `checksPassed`, `threadsResolved`,
`mergeable`, `reviewApproved` — without the terminal states, the CI-failure
trigger, or the conflict trigger. Use `checksFailed` alone for a "CI broke,
intervene now" watch, and `conflicted` alone for a stack watch that notifies
the moment a member branch falls behind its base.

The CI check counts follow the "non-pass" convention: `failed` counts only bad
conclusions/states (`FAILURE`, `ERROR`, `CANCELLED`, `TIMED_OUT`,
`ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`), `pending` counts not-yet-settled
runs. The notification text shows the raw counts so the receiver can see a
vacuous zero-check result.

## Requirements

- A `gh` CLI on the profile host, authenticated for the repositories being
  watched (`gh auth login`, or `GH_TOKEN`/`GITHUB_TOKEN` on servers). The
  plugin stores no token itself.
- The `agents` service (the live agent registry) — available in any profile
  that hosts agents.

## Install

```sh
dsh plugin --profile <profile> add dsh-pr-watcher
```

The bundle patch mounts the service, the tools, and a companion skill:

```yaml
# cordis.patch.yml (shipped with the bundle)
- insert:
    - id: pr-watcher
      name: dsh-pr-watcher/pr-watcher
      config:
        pollIntervalMs: 60000
        ghPath: gh
        delivery: followup
        allowResume: true
        notifySessionId: ""

    - id: tool-pr-watcher
      name: dsh-pr-watcher/tool-pr-watcher

    - id: skill-pr-watcher
      name: dsh-pr-watcher/skill-pr-watcher
```

The `skill-pr-watcher` row registers the bundled `dsh-pr-watcher` skill
(`assets/dsh-pr-watcher.md`) with the skill registry, so agents that mount the
skill see usage guidance for the tools. It activates only when the `prWatcher`
service is present.

Static watches go in the profile overlay that overrides the bundle patch:

```yaml
- insert:
    - id: pr-watcher
      name: dsh-pr-watcher/pr-watcher
      config:
        notifySessionId: "<coordinator-session-id>"
        watches:
          - id: example-1
            repo: example-org/example-repo
            number: 42
            conditions: [checksPassed, threadsResolved, mergeable, reviewApproved]
            notifyChanges: true
            sessionId: ""
            delivery: followup
```

Every static watch needs a notification target: its own `sessionId`, or the
global `notifySessionId`. A watch with neither fails the load loudly. Duplicate
watch ids, malformed `owner/name` references, unknown condition names, and the
`merged`+`closed` pair also fail at load.

The `gh` binary path and per-call timeout are configurable (`ghPath`,
`ghTimeoutMs`). The minimum poll interval is 30s.

### Runtime watches

The tools register watches from inside an agent turn; the target session is the
calling session, so no configuration is needed for the common case.

- `pr_status` — one-shot status of a PR: check counts, unresolved review
  threads, mergeable state, review decision, head ref, activity counts.
  Read-only; registers nothing.
- `pr_watch` — register a watch on the calling session. Accepts optional
  `id` (default `owner/name#number`), `conditions` (default the ready set),
  `notifyChanges`, and `delivery`. The first poll happens within one poll
  interval.
- `pr_watch_list` — list active watches: id, target PR, conditions, whether
  satisfied, whether already notified, last snapshot summary, last fetch
  error, last poll time.
- `pr_watch_remove` — stop a runtime-registered watch by id. Static config
  watches are not removable through this tool.

A watcher that is already satisfied stops notifying; to watch a new phase
( e.g. `merged` after the ready conditions fired), register a second watch.

## Delivered message shape

Satisfied transition:

```
PR watch "example-1" conditions met: example-org/example-repo#42 (https://github.com/...)
state: OPEN
checks: 0 failed, 0 pending of 32
review threads: 0 unresolved of 12
mergeable: MERGEABLE
review decision: APPROVED
changes: +2 commits, +3 review comments
watch satisfied; notifications for this watch stop here
```

Change notification (before satisfaction):

```
PR watch "example-1" changed: example-org/example-repo#42 (https://github.com/...)
state: OPEN
checks: 1 failed, 3 pending of 30
review threads: 2 unresolved of 12
changes: +1 commit, +2 review comments
```

Each delivery also emits a `pr-watcher/notify` Cordis event with the watch id,
whether it was the satisfied transition, the change summary, and the delivery
outcome, so other host plugins can react without parsing the message text.

## Failure behavior

A `gh` call that fails (non-zero exit, GraphQL error, invalid JSON) marks the
watch's `lastError` and keeps the previous snapshot, so a transient outage
never looks like a change. The next successful poll clears the error. A PR or
repository that does not exist reports `not found` and keeps the watch in the
error state.

## Development

```sh
pnpm install --config.auto-install-peers=false
pnpm run check   # typecheck + vitest + build
```

Dependencies are the published `@deepseek-ai/dsh-*` alpha packages; the CI
workflow installs with `--frozen-lockfile`. Tests cover the GraphQL-to-snapshot
mapping, condition evaluation, change detection, watch registry and
edge-triggered delivery (against a fake agent registry), and tool forwarding.

## License

MIT
