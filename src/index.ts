/**
 * Package root: re-exports the pr-watcher service surface so `.` importers get
 * the same bindings `build.mjs` bundles into `lib/index.js` from
 * `src/pr-watcher/index.ts`.
 * @module dsh-pr-watcher
 */

export type * from './pr-watcher/types.ts'
export {
  CONVERSATION_BODY_LIMIT,
  CONVERSATION_LIMIT,
  PR_QUERY,
  buildGhArgs,
  conversationCountsChanged,
  conversationFromRest,
  fetchConversation,
  ghGraphql,
  parseRepo,
  snapshotFromGraphql,
} from './pr-watcher/gh.ts'
export {
  buildNotificationText,
  conditionsMet,
  diffSnapshots,
  evaluateConditions,
  hasChanges,
  renderChanges,
  renderCommentLine,
} from './pr-watcher/conditions.ts'
export { PrWatcherService, default } from './pr-watcher/index.ts'
