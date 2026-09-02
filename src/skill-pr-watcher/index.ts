/**
 * Companion skill for the dsh-pr-watcher tools: tells the model how to use
 * `pr_status`, `pr_watch`, `pr_watch_list`, and `pr_watch_remove`, including
 * the condition semantics (edge-triggered satisfied notifications) and the
 * delivery modes.
 *
 * This is a thin skill provider, intentionally separate from
 * `tool-pr-watcher`: the service and tools remain usable without the skill,
 * while a preset that wants model guidance can mount this row alongside them.
 * It injects the `prWatcher` service so the skill only appears when the
 * service it describes is actually present.
 * @module dsh-pr-watcher
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
// Activates the `Context.prWatcher` merge declared by the pr-watcher service plugin.
import type {} from '../pr-watcher/index.ts'

const PROVIDER_NAME = 'dsh-pr-watcher'
const SKILL_BODY_URL = new URL('../../assets/dsh-pr-watcher.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = 'Monitor GitHub pull requests through the dsh-pr-watcher plugin: query PR status with pr_status, register a watch with pr_watch that notifies this session when configured conditions are met (checks settled, threads resolved, mergeable, approved, merged, closed), list and remove active watches. Use whenever you need to track a PR until it reaches a state instead of polling it manually.'
const CANDIDATE: SkillCandidate = {
  name: 'dsh-pr-watcher',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** Cordis plugin name. */
export const name = 'skill-pr-watcher'
/** Services required by the companion provider. */
export const inject = ['skills', 'prWatcher']

/** Register the bundled `dsh-pr-watcher` skill on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
