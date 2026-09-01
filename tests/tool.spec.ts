/** Model-facing tools: registration and forwarding to the prWatcher service. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolPrWatcher from '../src/tool-pr-watcher/index.ts'
import type { PrWatcherService } from '../src/pr-watcher/index.ts'
import type { PrSnapshot } from '../src/pr-watcher/types.ts'

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    repo: 'example-org/example-repo',
    number: 1,
    url: 'https://example.invalid/pr/1',
    state: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    headRefName: 'main',
    headRefOid: 'a'.repeat(40),
    commits: 1,
    reviews: 0,
    reviewThreads: 0,
    reviewComments: 0,
    issueComments: 0,
    unresolvedThreads: 0,
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    ...overrides,
  }
}

function fakeService(overrides: Record<string, unknown> = {}): PrWatcherService {
  return {
    check: vi.fn(async () => ({ ok: true, snapshot: snapshot() })),
    watch: vi.fn((spec: { id: string }) => ({ ok: true, id: spec.id })),
    unwatch: vi.fn((id: string) => id !== 'ghost'),
    list: vi.fn(() => []),
    ...overrides,
  } as unknown as PrWatcherService
}

async function mounted(service: PrWatcherService): Promise<{
  ctx: Context
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('prWatcher', service)
  const fiber = await ctx.plugin(toolPrWatcher)
  return { ctx, dispose: async () => { await fiber.dispose() } }
}

describe('tool-pr-watcher', () => {
  it('declares the prWatcher service and tools registry as dependencies', () => {
    expect(toolPrWatcher.inject).toEqual(['prWatcher', 'tools'])
  })

  it('registers all four tools', async () => {
    const { ctx, dispose } = await mounted(fakeService())
    expect(ctx.tools.get('pr_status')?.name).toBe('pr_status')
    expect(ctx.tools.get('pr_watch')?.name).toBe('pr_watch')
    expect(ctx.tools.get('pr_watch_list')?.name).toBe('pr_watch_list')
    expect(ctx.tools.get('pr_watch_remove')?.name).toBe('pr_watch_remove')
    await dispose()
  })

  it('pr_status forwards the query and renders the snapshot', async () => {
    const service = fakeService()
    const { ctx, dispose } = await mounted(service)
    const tool = ctx.tools.get('pr_status')!
    const result = await tool.execute(
      { repo: 'example-org/example-repo', number: 1 },
      { signal: new AbortController().signal } as never,
    )
    expect(service.check).toHaveBeenCalledWith('example-org/example-repo', 1)
    expect(result).toMatchObject({ ok: true })
    const rendered = tool.output!.render!(
      { repo: 'example-org/example-repo', number: 1 },
      { ok: true, snapshot: snapshot() } as never,
    )
    const text = (rendered as { text: string }[])[0]!.text
    expect(text).toContain('example-org/example-repo#1 OPEN')
    expect(text).toContain('checks: 0 failed, 0 pending of 1')
    await dispose()
  })

  it('pr_status renders the failure reason distinctly', async () => {
    const service = fakeService({ check: vi.fn(async () => ({ ok: false, reason: 'not found' })) })
    const { ctx, dispose } = await mounted(service)
    const tool = ctx.tools.get('pr_status')!
    const result = await tool.execute(
      { repo: 'example-org/example-repo', number: 9 },
      { signal: new AbortController().signal } as never,
    )
    expect(result).toEqual({ ok: false, reason: 'not found' })
    const rendered = tool.output!.render!(
      { repo: 'example-org/example-repo', number: 9 },
      result as never,
    )
    expect((rendered as { text: string }[])[0]!.text).toContain('not found')
    await dispose()
  })

  it('pr_watch targets the calling session', async () => {
    const service = fakeService()
    const { ctx, dispose } = await mounted(service)
    const tool = ctx.tools.get('pr_watch')!
    const exec = { agent: { session: { id: 'sess-9' } }, signal: new AbortController().signal } as never
    const result = await tool.execute({ repo: 'example-org/example-repo', number: 1, notifyChanges: true }, exec)
    expect(service.watch).toHaveBeenCalledWith(expect.objectContaining({
      id: 'example-org/example-repo#1',
      repo: 'example-org/example-repo',
      number: 1,
      notifyChanges: true,
      target: { sessionId: 'sess-9' },
    }))
    expect(result).toMatchObject({ ok: true, id: 'example-org/example-repo#1', sessionId: 'sess-9', notifyChanges: true })
    await dispose()
  })

  it('pr_watch rejects without an agent session', async () => {
    const service = fakeService()
    const { ctx, dispose } = await mounted(service)
    const tool = ctx.tools.get('pr_watch')!
    const result = await tool.execute(
      { repo: 'example-org/example-repo', number: 1 },
      { signal: new AbortController().signal } as never,
    )
    expect(result).toEqual({ ok: false, reason: 'no agent session context for this tool call' })
    expect(service.watch).not.toHaveBeenCalled()
    await dispose()
  })

  it('pr_watch_remove forwards to the service', async () => {
    const service = fakeService()
    const { ctx, dispose } = await mounted(service)
    const tool = ctx.tools.get('pr_watch_remove')!
    const result = await tool.execute(
      { id: 'w1' },
      { signal: new AbortController().signal } as never,
    )
    expect(service.unwatch).toHaveBeenCalledWith('w1')
    expect(result).toEqual({ ok: true, id: 'w1' })
    const missing = await tool.execute(
      { id: 'ghost' },
      { signal: new AbortController().signal } as never,
    )
    expect(missing).toMatchObject({ ok: false, reason: 'no watch with id "ghost"' })
    await dispose()
  })

  it('pr_watch_list renders an empty list', async () => {
    const { ctx, dispose } = await mounted(fakeService())
    const tool = ctx.tools.get('pr_watch_list')!
    const result = await tool.execute({}, { signal: new AbortController().signal } as never)
    expect(result).toEqual({ watches: [] })
    const rendered = tool.output!.render!({}, result as never)
    expect((rendered as { text: string }[])[0]!.text).toBe('no active PR watches')
    await dispose()
  })
})
