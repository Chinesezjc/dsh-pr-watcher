/** Companion skill plugin: registers the bundled dsh-pr-watcher skill only when the prWatcher service is present. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillPrWatcher from '../src/skill-pr-watcher/index.ts'
import type { PrWatcherService } from '../src/pr-watcher/index.ts'

const fakePrWatcher = {
  pollIntervalMs: 60000,
} as unknown as PrWatcherService

async function mounted(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  ctx.provide('prWatcher', fakePrWatcher)
  const fiber = await ctx.plugin(skillPrWatcher)
  return { ctx, dispose: async () => { await fiber.dispose() } }
}

describe('skill-pr-watcher', () => {
  it('declares the skill registry and prWatcher service as dependencies', () => {
    expect(skillPrWatcher.inject).toEqual(['skills', 'prWatcher'])
  })

  it('registers the bundled dsh-pr-watcher skill', async () => {
    const { ctx, dispose } = await mounted()
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))
    const listed = await ctx.skills.list()
    expect(listed).toEqual([{
      name: 'dsh-pr-watcher',
      description: expect.stringContaining('pr_watch'),
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-pr-watcher',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    }])
    await dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('loads the skill body with usage guidance', async () => {
    const { ctx, dispose } = await mounted()
    const loaded = await ctx.skills.get('dsh-pr-watcher')
    expect(loaded?.content).toContain('pr_watch')
    expect(loaded?.content).toContain('pr_status')
    expect(loaded?.content).toContain('edge-triggered')
    expect(loaded?.content).toContain('conditions met')
    await dispose()
  })

  it('ships the skill body file unchanged', async () => {
    const body = await readFile(new URL('../assets/dsh-pr-watcher.md', import.meta.url), 'utf8')
    expect(body).toContain('# dsh-pr-watcher')
    expect(body).toContain('pr_status')
    expect(body).toContain('pr_watch_list')
    expect(body).toContain('pr_watch_remove')
    expect(body).toContain('checksPassed')
    expect(body).toContain('One watch per phase')
  })
})
