/** Host service: config validation, watch registry, poll transitions, delivery. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PrWatcherService from '../src/pr-watcher/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PrSnapshot, WatchNotifyInfo } from '../src/pr-watcher/types.ts'

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
    failedChecks: [],
    conversation: [],
    ...overrides,
  }
}

/** Agent registry fake recording delivered texts per session, interconnect-style. */
function fakeAgents(options: {
  liveIds?: string[]
  headers?: Map<string, { origin?: string; parentSession?: string }>
  delivered?: Map<string, string[]>
  methods?: Map<string, string[]>
} = {}) {
  const { liveIds = [], headers = new Map(), delivered = new Map(), methods = new Map() } = options
  const record = (id: string, method: string) => (message: { content: readonly { type: 'text'; text: string }[] }): void => {
    const texts = delivered.get(id) ?? []
    for (const block of message.content) texts.push(block.text)
    delivered.set(id, texts)
    const called = methods.get(id) ?? []
    called.push(method)
    methods.set(id, called)
  }
  const makeAgent = (id: string): Agent => ({
    id,
    session: { id, header: headers.get(id) ?? {} },
    inject: record(id, 'inject'),
    followup: record(id, 'followup'),
    steer: record(id, 'steer'),
  }) as unknown as Agent
  return {
    get(id: string): Agent | undefined {
      return liveIds.includes(id) ? makeAgent(id) : undefined
    },
    list(): Agent[] {
      return liveIds.map(makeAgent)
    },
    isOwnedBy: vi.fn(() => false),
  }
}

class TestService extends PrWatcherService {
  fetchImpl: ((spec: { repo: string; number: number }) => Promise<PrSnapshot>) | undefined

  protected override async fetchSnapshot(
    spec: { repo: string; number: number },
    _prev?: PrSnapshot,
  ): Promise<PrSnapshot> {
    if (this.fetchImpl === undefined) throw new Error('no fetchImpl configured')
    return this.fetchImpl(spec)
  }
}

async function mounted(config: Record<string, unknown> = {}, agentsOptions: Parameters<typeof fakeAgents>[0] = {}): Promise<{
  ctx: Context
  service: TestService
  delivered: Map<string, string[]>
  methods: Map<string, string[]>
  notifications: WatchNotifyInfo[]
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const delivered = new Map<string, string[]>()
  const methods = new Map<string, string[]>()
  const notifications: WatchNotifyInfo[] = []
  ctx.provide('agents', fakeAgents({ ...agentsOptions, delivered, methods }) as never)
  const fiber = await ctx.plugin(TestService, { pollIntervalMs: 30000, ...config })
  const service = ctx.prWatcher as unknown as TestService
  ctx.on('pr-watcher/notify', (info) => notifications.push(info))
  return {
    ctx,
    service,
    delivered,
    methods,
    notifications,
    dispose: async () => { await fiber.dispose() },
  }
}

async function expectPluginThrows(ctx: Context, config: Record<string, unknown>, pattern: RegExp): Promise<void> {
  try {
    await ctx.plugin(TestService, { pollIntervalMs: 30000, ...config })
  } catch (error) {
    expect(String(error)).toMatch(pattern)
    return
  }
  throw new Error(`expected plugin mount to throw matching ${pattern}`)
}

const WATCH = {
  id: 'w1',
  repo: 'example-org/example-repo',
  number: 1,
  conditions: ['checksPassed'] as const,
  notifyChanges: false,
  target: { sessionId: 'sess-1' },
}

describe('config watch validation', () => {
  it('rejects duplicate watch ids', async () => {
    const ctx = new Context()
    ctx.provide('agents', fakeAgents() as never)
    await expectPluginThrows(ctx, {
      watches: [
        { id: 'dup', repo: 'example-org/example-repo', number: 1, sessionId: 'sess-1' },
        { id: 'dup', repo: 'example-org/example-repo', number: 2, sessionId: 'sess-1' },
      ],
    }, /duplicate watch id "dup"/)
  })

  it('rejects a watch without any notification target', async () => {
    const ctx = new Context()
    ctx.provide('agents', fakeAgents() as never)
    await expectPluginThrows(ctx, {
      watches: [{ id: 'orphan', repo: 'example-org/example-repo', number: 1 }],
    }, /has no notification target/)
  })

  it('rejects contradictory merged+closed conditions', async () => {
    const ctx = new Context()
    ctx.provide('agents', fakeAgents() as never)
    await expectPluginThrows(ctx, {
      watches: [{ id: 'both', repo: 'example-org/example-repo', number: 1, sessionId: 'sess-1', conditions: ['merged', 'closed'] }],
    }, /cannot include both merged and closed/)
  })

  it('rejects contradictory checksPassed+checksFailed conditions', async () => {
    const ctx = new Context()
    ctx.provide('agents', fakeAgents() as never)
    await expectPluginThrows(ctx, {
      watches: [{ id: 'checks', repo: 'example-org/example-repo', number: 1, sessionId: 'sess-1', conditions: ['checksPassed', 'checksFailed'] }],
    }, /cannot include both checksPassed and checksFailed/)
  })

  it('rejects contradictory mergeable+conflicted conditions', async () => {
    const ctx = new Context()
    ctx.provide('agents', fakeAgents() as never)
    await expectPluginThrows(ctx, {
      watches: [{ id: 'conflict', repo: 'example-org/example-repo', number: 1, sessionId: 'sess-1', conditions: ['mergeable', 'conflicted'] }],
    }, /cannot include both mergeable and conflicted/)
  })

  it('rejects malformed repository references', async () => {
    const ctx = new Context()
    ctx.provide('agents', fakeAgents() as never)
    await expectPluginThrows(ctx, {
      watches: [{ id: 'bad', repo: 'no-slash', number: 1, sessionId: 'sess-1' }],
    }, /owner\/name/)
  })
})

describe('watch registry', () => {
  it('registers, lists, and removes a watch', async () => {
    const { service, dispose } = await mounted()
    expect(service.watch(WATCH)).toEqual({ ok: true, id: 'w1' })
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0]).toMatchObject({ id: 'w1', satisfied: false, notified: false })
    expect(service.unwatch('w1')).toBe(true)
    expect(service.list()).toHaveLength(0)
    expect(service.unwatch('w1')).toBe(false)
    await dispose()
  })

  it('rejects duplicates, empty ids, empty targets, and invalid numbers', async () => {
    const { service, dispose } = await mounted()
    expect(service.watch(WATCH).ok).toBe(true)
    expect(service.watch(WATCH).ok).toBe(false)
    expect(service.watch({ ...WATCH, id: '' }).ok).toBe(false)
    expect(service.watch({ ...WATCH, id: 'w2', target: { sessionId: '' } }).ok).toBe(false)
    expect(service.watch({ ...WATCH, id: 'w3', number: 0 }).ok).toBe(false)
    expect(service.watch({ ...WATCH, id: 'w4', repo: 'no-slash' }).ok).toBe(false)
    expect(service.watch({ ...WATCH, id: 'w5', conditions: ['merged', 'closed'] }).ok).toBe(false)
    await dispose()
  })
})

describe('poll transitions', () => {
  it('delivers exactly once on the satisfied edge', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch(WATCH)
    const seq = [
      snapshot({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }),
      snapshot(),
      snapshot(),
    ]
    let i = 0
    service.fetchImpl = async () => seq[i++] ?? snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toBeUndefined()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(delivered.get('sess-1')![0]).toContain('conditions met')
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    const status = service.list()[0]!
    expect(status.satisfied).toBe(true)
    expect(status.notified).toBe(true)
    await dispose()
  })

  it('emits a change notification before satisfaction when notifyChanges is on', async () => {
    const { service, delivered, notifications, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'w2', conditions: ['merged'], notifyChanges: true })
    const seq = [snapshot({ commits: 1 }), snapshot({ commits: 2 })]
    let i = 0
    service.fetchImpl = async () => seq[i++] ?? snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toBeUndefined()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(delivered.get('sess-1')![0]).toContain('changed')
    expect(delivered.get('sess-1')![0]).toContain('+1 commit')
    expect(delivered.get('sess-1')![0]).not.toContain('conditions met')
    expect(notifications[0]).toMatchObject({ satisfied: false, delivered: true })
    await dispose()
  })

  it('combines the satisfied transition and changes in one message', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, notifyChanges: true })
    const seq = [
      snapshot({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }),
      snapshot({ commits: 2 }),
    ]
    let i = 0
    service.fetchImpl = async () => seq[i++] ?? snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    const text = delivered.get('sess-1')![0]!
    expect(text).toContain('conditions met')
    expect(text).toContain('+1 commit')
    await dispose()
  })

  it('notifies when a check-run turns red (notifyChanges covers check state)', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'ci-red', notifyChanges: true })
    const seq = [
      snapshot({ checks: { total: 2, passed: 0, failed: 0, pending: 2 } }),
      snapshot({ checks: { total: 2, passed: 0, failed: 1, pending: 1 }, failedChecks: ['lint'] }),
    ]
    let i = 0
    service.fetchImpl = async () => seq[i++] ?? snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toBeUndefined()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    const text = delivered.get('sess-1')![0]!
    expect(text).toContain('changed')
    expect(text).toContain('checks: +1 failed, -1 pending')
    expect(text).toContain('newly failed: lint')
    expect(text).not.toContain('conditions met')
    await dispose()
  })

  it('embeds newly arrived conversation comments in the change notification', async () => {
    const first = { key: 'issue-1', kind: 'issue' as const, author: 'alice', createdAt: '2026-09-03T01:00:00Z', body: 'baseline', url: 'u1' }
    const second = { key: 'issue-2', kind: 'issue' as const, author: 'reviewer', createdAt: '2026-09-03T02:00:00Z', body: 'please rename this variable', url: 'u2' }
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'conv', conditions: ['merged'], notifyChanges: true })
    const seq = [
      snapshot({ conversation: [first] }),
      snapshot({ conversation: [second, first] }),
    ]
    let i = 0
    service.fetchImpl = async () => seq[i++] ?? snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toBeUndefined()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    const text = delivered.get('sess-1')![0]!
    expect(text).toContain('new comments:')
    expect(text).toContain('reviewer')
    expect(text).toContain('please rename this variable')
    await dispose()
  })

  it('a checksFailed-condition watch satisfies once CI turns red', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'ci-broken', conditions: ['checksFailed'], notifyChanges: false })
    const seq = [
      snapshot(),
      snapshot({ checks: { total: 2, passed: 1, failed: 1, pending: 0 }, failedChecks: ['lint'] }),
      snapshot({ checks: { total: 2, passed: 1, failed: 1, pending: 0 }, failedChecks: ['lint'] }),
    ]
    let i = 0
    service.fetchImpl = async () => seq[i++] ?? snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toBeUndefined()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(delivered.get('sess-1')![0]).toContain('conditions met')
    expect(service.list()[0]!.satisfied).toBe(true)
    // No repeat notification while still red.
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    await dispose()
  })

  it('a conflicted-condition watch satisfies when the PR needs a merge-forward', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'stack-member', conditions: ['conflicted'], notifyChanges: true })
    const seq = [
      snapshot({ mergeable: 'MERGEABLE' }),
      snapshot({ mergeable: 'CONFLICTING' }),
      snapshot({ mergeable: 'CONFLICTING' }),
    ]
    let i = 0
    service.fetchImpl = async () => seq[i++] ?? snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toBeUndefined()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    const text = delivered.get('sess-1')![0]!
    expect(text).toContain('conditions met')
    expect(text).toContain('mergeable: MERGEABLE -> CONFLICTING')
    expect(service.list()[0]!.satisfied).toBe(true)
    // Already satisfied; the mergeable transition also fired once via the change path.
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    await dispose()
  })

  it('keeps polling and reports fetch failures without delivering', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch(WATCH)
    let calls = 0
    service.fetchImpl = async () => {
      calls += 1
      if (calls === 1) throw new Error('gh unavailable')
      return snapshot()
    }
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(service.list()[0]!.lastError).toContain('gh unavailable')
    expect(delivered.get('sess-1')).toBeUndefined()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(service.list()[0]!.lastError).toBeUndefined()
    expect(delivered.get('sess-1')).toHaveLength(1)
    await dispose()
  })
})

describe('delivery fences', () => {
  it('refuses subagent-owned sessions', async () => {
    const headers = new Map([['sess-1', { origin: 'subagent' }]])
    const { service, delivered, notifications, dispose } = await mounted({}, { liveIds: ['sess-1'], headers })
    service.watch(WATCH)
    service.fetchImpl = async () => snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toBeUndefined()
    expect(notifications[0]).toMatchObject({ satisfied: true, delivered: false })
    await dispose()
  })

  it('refuses not-live sessions when resume is off', async () => {
    const { service, delivered, notifications, dispose } = await mounted({ allowResume: false })
    service.watch(WATCH)
    service.fetchImpl = async () => snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toBeUndefined()
    expect(notifications[0]).toMatchObject({ delivered: false })
    await dispose()
  })

  it('default delivery wakes a live session via followup', async () => {
    const { service, delivered, methods, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch(WATCH)
    service.fetchImpl = async () => snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(methods.get('sess-1')).toEqual(['followup'])
    await dispose()
  })

  it('explicit inject delivery seeds context without waking', async () => {
    const { service, delivered, methods, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, target: { sessionId: 'sess-1', delivery: 'inject' } })
    service.fetchImpl = async () => snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(methods.get('sess-1')).toEqual(['inject'])
    await dispose()
  })

  it('delivers to a live session with the configured mode', async () => {
    const { service, delivered, methods, dispose } = await mounted(
      { delivery: 'steer' },
      { liveIds: ['sess-1'] },
    )
    service.watch(WATCH)
    service.fetchImpl = async () => snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(methods.get('sess-1')).toEqual(['steer'])
    await dispose()
  })
})

describe('one-shot check', () => {
  it('returns the snapshot on success and the reason on failure', async () => {
    const { service, dispose } = await mounted()
    service.fetchImpl = async () => snapshot()
    const ok = await service.check('example-org/example-repo', 1)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.snapshot.state).toBe('OPEN')
    service.fetchImpl = async () => { throw new Error('boom') }
    const bad = await service.check('example-org/example-repo', 1)
    expect(bad).toEqual({ ok: false, reason: 'boom' })
    await dispose()
  })
})
