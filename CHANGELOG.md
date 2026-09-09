# Changelog

## 0.7.0

- Persist runtime watches: new `stateFile` config option writes the active
  watch set atomically and restores it on the next activation, so `pr_watch`
  registrations survive process restarts. Empty (default) keeps runtime
  watches ephemeral, as before.
- Truncation fail-closed: snapshots flag when the 100-item check-context or
  review-thread window was smaller than the PR's real count, and
  `checksPassed` / `threadsResolved` refuse to satisfy on a truncated window
  instead of reading hidden failures as green.
- A satisfied watch is now fully silent: after the single edge notification it
  delivers nothing further, matching the documented one-watch-per-phase model
  (previously change notifications could still fire after satisfaction).
- Exponential backoff per watch on consecutive gh failures (30s doubling to a
  10min ceiling); the poll cycle skips a watch inside its backoff window
  instead of hammering a failing or rate-limited endpoint.
- The real snapshot gate (fetch conversation only when comment counts moved;
  retain the previous window on quiet polls and on conversation-fetch
  failure) is now covered by unit tests through two seams instead of being
  stubbed wholesale.

## 0.6.0

- Read the PR conversation: snapshots carry a newest-first window of issue
  comments, review summaries, and inline review comments (author, time, body,
  file path) fetched over the gh REST endpoints only when a comment count
  changed; new comments are embedded in notifications under a `new comments:`
  block; `pr_status` returns and renders the conversation.

## 0.5.0

- Notifications wake the target agent by default: delivery defaults to
  `followup` (queues its own turn; wakes an idle-loaded session) and
  `allowResume` defaults to true (a fully unloaded persisted session is
  resumed). `inject` stays available for opt-in silent seeding.

## 0.4.0

- New `conflicted` condition (mergeable `CONFLICTING`) for stack watches;
  mergeable-state transitions are part of change notifications;
  `mergeable`+`conflicted` rejected as a contradictory pair; the companion
  skill documents the stack-conflict resolution procedure and the
  empty-commit prohibition.

## 0.3.0

- Change notifications cover check-run transitions: signed per-state check
  deltas and newly failed check names; new `checksFailed` condition;
  `checksPassed`+`checksFailed` rejected as contradictory.

## 0.2.0

- Companion `skill-pr-watcher` plugin registers the bundled
  `dsh-pr-watcher` skill with usage guidance for the tools.

## 0.1.0

- Initial release: host `pr-watcher` service (gh-backed polling, condition
  evaluation, edge-triggered notifications) and the `pr_status` /
  `pr_watch` / `pr_watch_list` / `pr_watch_remove` tools.

## 0.8.0

- Report window truncation to the session: when a PR has more than 100 check
  contexts or review threads, the notification and `pr_status` carry a
  `note:` line with the real total ("250 check contexts in total; only the
  newest 100 were fetched, so the counts above are partial"), and the
  snapshot exposes the real context total as `checkContexts`.

## 0.8.1

- The checks line's denominator is the real context total (`of N` uses
  `checkContexts`), matching the review-threads line; the truncation note
  names how many were actually fetched.

## 0.9.0

- Default delivery mode is now `steer`: a notification cuts into the nearest
  step boundary of a running turn (and wakes an idle-loaded session) instead
  of queueing behind current work. `followup` (queue its own turn) and
  `inject` (silent seeding) remain available per watch / per config.

## 0.10.0

- Change notifications are ON by default: `pr_watch` (and config watches)
  notify on every observed change — new comments with content, commits,
  check-run and mergeable-state transitions — unless `notifyChanges: false`
  is passed. Reviewer comments therefore always reach the session instead of
  being gated behind an opt-in flag.
