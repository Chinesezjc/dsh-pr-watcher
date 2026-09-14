/** Host service: config validation, watch registry, poll transitions, delivery. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PrWatcherService, { isRateLimitMessage } from '../src/pr-watcher/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BranchSnapshot, ConversationEntry, PrSnapshot, WatchNotifyInfo } from '../src/pr-watcher/types.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    kind: 'pr',
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
    checksTruncated: false,
    threadsTruncated: false,
    checkContexts: 1,
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
  /** Feeds the GraphQL half of fetchSnapshot (the real gate runs on top). */
  fetchImpl: ((spec: { repo: string; number: number }) => Promise<PrSnapshot>) | undefined
  /** Feeds the REST conversation half; defaults to an empty window. */
  convImpl: ((spec: { repo: string; number: number }) => Promise<ConversationEntry[]>) | undefined
  /** Feeds the branch half of fetchSnapshot for branch watches. */
  branchImpl: ((spec: { repo: string; branch: string }) => Promise<BranchSnapshot>) | undefined
  /** Login the comment filter treats as the watching account; tests pin it. */
  login: string | undefined = 'watching-account'
  /** Pinned clock for the throttle window; undefined uses the real clock. */
  clock: number | undefined
  /** How many times the pacing delay was entered between two watch polls. */
  paceCalls = 0
  convCalls = 0

  protected override async fetchBase(spec: { repo: string; number: number }): Promise<PrSnapshot> {
    if (this.fetchImpl === undefined) throw new Error('no fetchImpl configured')
    return this.fetchImpl(spec)
  }

  protected override async fetchConversationWindow(spec: { repo: string; number: number }): Promise<ConversationEntry[]> {
    this.convCalls += 1
    if (this.convImpl === undefined) return []
    return this.convImpl(spec)
  }

  protected override async fetchBranchBase(spec: { repo: string; branch: string }): Promise<BranchSnapshot> {
    if (this.branchImpl === undefined) throw new Error('no branchImpl configured')
    return this.branchImpl(spec)
  }

  /** Pin the authenticated login so unit tests never shell out to gh. */
  protected override async resolveSelfLogin(): Promise<string | undefined> {
    return this.login
  }

  /** Advance the throttle window deterministically instead of waiting. */
  protected override now(): number {
    return this.clock ?? Date.now()
  }

  /** Never wait between watches in tests. */
  protected override async pace(): Promise<void> {
    this.paceCalls += 1
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
    // The base snapshots move the issue-comment count so the real fetch gate
    // fetches the conversation window through the seam.
    const seq = [
      snapshot({ issueComments: 1 }),
      snapshot({ issueComments: 2 }),
    ]
    const windows: ConversationEntry[][] = [[first], [second, first]]
    let i = 0
    service.fetchImpl = async () => seq[i] ?? snapshot()
    service.convImpl = async () => windows[Math.min(i, windows.length - 1)] ?? []
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    i = 1
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

  it('backs off after a failure and recovers once the backoff window is reset', async () => {
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
    // The immediate second cycle is inside the backoff window: no new fetch.
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(1)
    // Re-registering resets the backoff state; the next poll succeeds.
    service.unwatch('w1')
    service.watch(WATCH)
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

  it('default delivery cuts into a live session via steer', async () => {
    const { service, delivered, methods, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch(WATCH)
    service.fetchImpl = async () => snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(methods.get('sess-1')).toEqual(['steer'])
    await dispose()
  })

  it('explicit followup delivery queues a turn', async () => {
    const { service, delivered, methods, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'followup-watch', target: { sessionId: 'sess-1', delivery: 'followup' } })
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
    if (ok.ok && ok.snapshot.kind === 'pr') expect(ok.snapshot.state).toBe('OPEN')
    service.fetchImpl = async () => { throw new Error('boom') }
    const bad = await service.check('example-org/example-repo', 1)
    expect(bad).toEqual({ ok: false, reason: 'boom' })
    await dispose()
  })
})

describe('conversation gate in the real fetchSnapshot', () => {
  const ENTRY: ConversationEntry = { key: 'issue-1', kind: 'issue', author: 'a', createdAt: '2026-09-03T01:00:00Z', body: 'x', url: 'u' }

  it('retains the previous window without calling the REST seam when counts are unchanged', async () => {
    const { service, dispose } = await mounted()
    const base = snapshot({ issueComments: 5 })
    service.fetchImpl = async () => base
    const prev = { ...base, conversation: [ENTRY] }
    const result = await (service as unknown as { fetchSnapshot(spec: { repo: string; number: number }, prev?: PrSnapshot): Promise<PrSnapshot> }).fetchSnapshot({ repo: 'example-org/example-repo', number: 1 }, prev)
    expect(result.conversation).toEqual([ENTRY])
    expect(service.convCalls).toBe(0)
    await dispose()
  })

  it('fetches the window through the seam when a comment count moved', async () => {
    const { service, dispose } = await mounted()
    const newer: ConversationEntry = { ...ENTRY, key: 'issue-2', body: 'y' }
    service.fetchImpl = async () => snapshot({ issueComments: 6 })
    service.convImpl = async () => [newer, ENTRY]
    const prev = { ...snapshot({ issueComments: 5 }), conversation: [ENTRY] }
    const result = await (service as unknown as { fetchSnapshot(spec: { repo: string; number: number }, prev?: PrSnapshot): Promise<PrSnapshot> }).fetchSnapshot({ repo: 'example-org/example-repo', number: 1 }, prev)
    expect(result.conversation).toEqual([newer, ENTRY])
    expect(service.convCalls).toBe(1)
    await dispose()
  })

  it('keeps the previous window when the conversation fetch fails', async () => {
    const { service, dispose } = await mounted()
    service.fetchImpl = async () => snapshot({ issueComments: 6 })
    service.convImpl = async () => { throw new Error('rate limited') }
    const prev = { ...snapshot({ issueComments: 5 }), conversation: [ENTRY] }
    const result = await (service as unknown as { fetchSnapshot(spec: { repo: string; number: number }, prev?: PrSnapshot): Promise<PrSnapshot> }).fetchSnapshot({ repo: 'example-org/example-repo', number: 1 }, prev)
    expect(result.conversation).toEqual([ENTRY])
    await dispose()
  })
})

describe('watch persistence', () => {
  function tempStateFile(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'prw-state-'))
    return { dir, file: join(dir, 'state.json') }
  }

  it('survives a service restart through the state file', async () => {
    const { dir, file } = tempStateFile()
    try {
      const first = await mounted({ stateFile: file })
      expect(first.service.watch(WATCH).ok).toBe(true)
      await first.dispose()
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf8')).watches).toHaveLength(1)

      const second = await mounted({ stateFile: file })
      expect(second.service.list().map((w) => w.id)).toEqual(['w1'])
      expect(second.service.unwatch('w1')).toBe(true)
      await second.dispose()
      expect(JSON.parse(readFileSync(file, 'utf8')).watches).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails the load loudly on a corrupt or version-mismatched state file', async () => {
    const { dir, file } = tempStateFile()
    try {
      const ctx = new Context()
      ctx.provide('agents', fakeAgents() as never)
      writeFileSync(file, 'not json')
      await expectPluginThrows(ctx, { stateFile: file }, /cannot read state file/)
      writeFileSync(file, JSON.stringify({ version: 99, watches: [] }))
      await expectPluginThrows(ctx, { stateFile: file }, /unsupported format/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('backoff and satisfied-silence', () => {
  it('skips further fetches inside the backoff window after a failure', async () => {
    const { service, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch(WATCH)
    let calls = 0
    service.fetchImpl = async () => {
      calls += 1
      throw new Error('gh unavailable')
    }
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(1)
    expect(service.list()[0]!.lastError).toContain('gh unavailable')
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(1)
    await dispose()
  })

  it('stays silent after the satisfied notification even when later changes arrive', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'once', notifyChanges: true })
    const seq = [
      snapshot({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }),
      snapshot(),
      snapshot({ commits: 2 }),
    ]
    let i = 0
    service.fetchImpl = async () => seq[i++] ?? snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(delivered.get('sess-1')![0]).toContain('conditions met')
    // The +1 commit after satisfaction must NOT produce a second notification.
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    await dispose()
  })
})

describe('notifyChanges default', () => {
  it('config watches default to change notifications on', async () => {
    const { service, dispose } = await mounted({
      watches: [{ id: 'cfg', repo: 'example-org/example-repo', number: 1, sessionId: 'sess-1' }],
    })
    expect(service.list()[0]!.notifyChanges).toBe(true)
    await dispose()
  })
})

function branch(overrides: Partial<BranchSnapshot> = {}): BranchSnapshot {
  return {
    kind: 'branch',
    repo: 'example-org/example-repo',
    branch: 'master',
    url: 'https://example.invalid/tree/master',
    headOid: 'c'.repeat(40),
    committedDate: '2026-09-03T01:00:00Z',
    commits: 10,
    ...overrides,
  }
}

const BRANCH_WATCH = {
  id: 'example-org/example-repo@master',
  repo: 'example-org/example-repo',
  branch: 'master',
  conditions: [] as const,
  notifyChanges: true,
  target: { sessionId: 'sess-1' },
}

describe('branch watches', () => {
  it('registers, lists, and removes a branch watch', async () => {
    const { service, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    expect(service.watch(BRANCH_WATCH)).toEqual({ ok: true, id: 'example-org/example-repo@master' })
    const status = service.list()[0]!
    expect(status).toMatchObject({ branch: 'master', repo: 'example-org/example-repo', satisfied: false })
    expect(status.number).toBeUndefined()
    expect(status.conditions).toEqual([])
    await dispose()
  })

  it('rejects a branch watch with conditions, and a watch with neither or both targets', async () => {
    const { service, dispose } = await mounted()
    expect(service.watch({ ...BRANCH_WATCH, id: 'b1', conditions: ['merged'] })).toEqual({
      ok: false,
      reason: 'branch watches take no conditions; they notify on every head advance',
    })
    const neither = service.watch({ ...BRANCH_WATCH, id: 'b2', branch: undefined })
    expect(neither.ok).toBe(false)
    expect(neither).toMatchObject({ reason: 'exactly one of number (pull request) or branch must be provided' })
    const both = service.watch({ ...BRANCH_WATCH, id: 'b3', number: 1 })
    expect(both.ok).toBe(false)
    expect(both).toMatchObject({ reason: 'exactly one of number (pull request) or branch must be provided' })
    // An empty branch string is the same as no branch at all.
    const empty = service.watch({ ...BRANCH_WATCH, id: 'b4', branch: '' })
    expect(empty.ok).toBe(false)
    await dispose()
  })

  it('notifies when the branch head advances and stays silent when it does not', async () => {
    const { service, delivered, notifications, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch(BRANCH_WATCH)
    const seq = [
      branch({ commits: 10 }),
      branch({ headOid: 'd'.repeat(40), commits: 12, committedDate: '2026-09-04T01:00:00Z' }),
      branch({ headOid: 'd'.repeat(40), commits: 12, committedDate: '2026-09-04T01:00:00Z' }),
    ]
    let i = 0
    service.branchImpl = async () => seq[i++] ?? seq[2]!
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    // The first poll only establishes the baseline.
    expect(delivered.get('sess-1')).toBeUndefined()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    const text = delivered.get('sess-1')![0]!
    expect(text).toContain('PR watch "example-org/example-repo@master" changed')
    expect(text).toContain('branch: master')
    expect(text).toContain('commits: 12')
    expect(text).toContain('changes: branch advanced cccccccc -> dddddddd, +2 commits')
    expect(text).not.toContain('conditions met')
    expect(notifications[0]).toMatchObject({ branch: 'master', satisfied: false, delivered: true })
    expect(notifications[0]!.number).toBeUndefined()
    // An unchanged head produces no further notification.
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(service.list()[0]!.satisfied).toBe(false)
    await dispose()
  })

  it('rejects a branch watch with change notifications disabled', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    expect(service.watch({ ...BRANCH_WATCH, id: 'quiet', notifyChanges: false })).toEqual({
      ok: false,
      reason: 'a branch watch must keep change notifications on; it has no conditions to satisfy',
    })
    const seq = [branch(), branch({ headOid: 'd'.repeat(40), commits: 11 })]
    let i = 0
    service.branchImpl = async () => seq[i++] ?? seq[1]!
    service.watch(BRANCH_WATCH)
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(delivered.get('sess-1')).toHaveLength(1)
    await dispose()
  })

  it('surfaces a branch fetch failure through the backoff path', async () => {
    const { service, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch(BRANCH_WATCH)
    let calls = 0
    service.branchImpl = async () => {
      calls += 1
      throw new Error('branch not found in example-org/example-repo')
    }
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(1)
    expect(service.list()[0]!.lastError).toContain('branch not found')
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(1)
    await dispose()
  })

  it('mounts a config-declared branch watch with no conditions', async () => {
    const { service, dispose } = await mounted({
      watches: [{ id: 'cfg-branch', repo: 'example-org/example-repo', branch: 'master', sessionId: 'sess-1' }],
    })
    expect(service.list()[0]).toMatchObject({ id: 'cfg-branch', branch: 'master', conditions: [] })
    await dispose()
  })

  it('rejects a config watch with both targets and a config branch watch with conditions', async () => {
    const both = new Context()
    both.provide('agents', fakeAgents() as never)
    await expectPluginThrows(both, {
      watches: [{ id: 'both', repo: 'example-org/example-repo', number: 1, branch: 'master', sessionId: 'sess-1' }],
    }, /exactly one of number \(pull request\) or branch must be provided/)
    const conditioned = new Context()
    conditioned.provide('agents', fakeAgents() as never)
    await expectPluginThrows(conditioned, {
      watches: [{
        id: 'cfg-branch',
        repo: 'example-org/example-repo',
        branch: 'master',
        sessionId: 'sess-1',
        conditions: ['mergeable'],
      }],
    }, /branch watches take no conditions/)
    const quiet = new Context()
    quiet.provide('agents', fakeAgents() as never)
    await expectPluginThrows(quiet, {
      watches: [{
        id: 'cfg-branch',
        repo: 'example-org/example-repo',
        branch: 'master',
        sessionId: 'sess-1',
        notifyChanges: false,
      }],
    }, /branch watches must keep change notifications on/)
  })

  it('returns the branch snapshot from checkBranch and the reason on failure', async () => {
    const { service, dispose } = await mounted()
    service.branchImpl = async () => branch()
    const ok = await service.checkBranch('example-org/example-repo', 'master')
    expect(ok.ok).toBe(true)
    if (ok.ok && ok.snapshot.kind === 'branch') expect(ok.snapshot.commits).toBe(10)
    service.branchImpl = async () => { throw new Error('boom') }
    expect(await service.checkBranch('example-org/example-repo', 'master')).toEqual({ ok: false, reason: 'boom' })
    await dispose()
  })

  it('persists a branch watch and restores it on restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prw-branch-'))
    const file = join(dir, 'state.json')
    try {
      const first = await mounted({ stateFile: file })
      expect(first.service.watch(BRANCH_WATCH).ok).toBe(true)
      await first.dispose()
      const record = JSON.parse(readFileSync(file, 'utf8')).watches[0]
      expect(record).toMatchObject({ id: BRANCH_WATCH.id, branch: 'master' })
      expect(record.number).toBeUndefined()

      const second = await mounted({ stateFile: file })
      expect(second.service.list()[0]).toMatchObject({ id: BRANCH_WATCH.id, branch: 'master' })
      await second.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a persisted branch watch that carries conditions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prw-branch-bad-'))
    const file = join(dir, 'state.json')
    try {
      writeFileSync(file, JSON.stringify({
        version: 1,
        watches: [{
          id: 'bad-branch',
          repo: 'example-org/example-repo',
          branch: 'master',
          conditions: ['merged'],
          target: { sessionId: 'sess-1' },
        }],
      }))
      const ctx = new Context()
      ctx.provide('agents', fakeAgents() as never)
      await expectPluginThrows(ctx, { stateFile: file }, /branch watches take no conditions/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('own-comment filtering', () => {
  const MINE: ConversationEntry = { key: 'issue-1', kind: 'issue', author: 'watching-account', createdAt: '2026-09-03T02:00:00Z', body: 'my own reply', url: 'u1' }
  const THEIRS: ConversationEntry = { key: 'issue-2', kind: 'issue', author: 'reviewer', createdAt: '2026-09-03T03:00:00Z', body: 'please rename this', url: 'u2' }

  /**
   * Poll twice: pass 1 records the baseline with `windows[0]`, pass 2 returns
   * `next` with `windows[1]`. The window must grow between passes, exactly like
   * the REST endpoints do — returning the final window twice hides the new
   * comment from the diff.
   */
  async function pollTwo(
    service: TestService,
    baseline: PrSnapshot,
    next: PrSnapshot,
    windows: ConversationEntry[][],
  ): Promise<void> {
    let pass = 0
    service.fetchImpl = async () => (pass === 0 ? baseline : next)
    service.convImpl = async () => windows[Math.min(pass, windows.length - 1)] ?? []
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    pass = 1
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
  }

  it('does not notify when the only new comment is the watching account\'s own', async () => {
    const { service, delivered, notifications, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'quiet-self', conditions: ['merged'], notifyChanges: true })
    await pollTwo(
      service,
      snapshot({ issueComments: 1, conversation: [] }),
      snapshot({ issueComments: 2, conversation: [MINE] }),
      [[], [MINE]],
    )
    expect(delivered.get('sess-1')).toBeUndefined()
    expect(notifications).toHaveLength(0)
    await dispose()
  })

  it('notifies for another author and embeds only their comment', async () => {
    const { service, delivered, notifications, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'mixed', conditions: ['merged'], notifyChanges: true })
    await pollTwo(
      service,
      snapshot({ issueComments: 1, conversation: [] }),
      snapshot({ issueComments: 3, conversation: [THEIRS, MINE] }),
      [[], [THEIRS, MINE]],
    )
    expect(delivered.get('sess-1')).toHaveLength(1)
    const text = delivered.get('sess-1')![0]!
    expect(text).toContain('please rename this')
    expect(text).not.toContain('my own reply')
    expect(text).toContain('note: 1 new comment from a filtered author was ignored')
    expect(notifications[0]).toMatchObject({ ignoredComments: 1, delivered: true })
  })

  it('notifies about own comments when the watch opts out', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'loud-self', conditions: ['merged'], notifyChanges: true, ignoreOwnComments: false })
    await pollTwo(
      service,
      snapshot({ issueComments: 1, conversation: [] }),
      snapshot({ issueComments: 2, conversation: [MINE] }),
      [[], [MINE]],
    )
    expect(delivered.get('sess-1')).toHaveLength(1)
    expect(delivered.get('sess-1')![0]).toContain('my own reply')
  })

  it('filters configured extra authors regardless of the own-comment flag', async () => {
    const { service, delivered, dispose } = await mounted(
      { ignoreCommentAuthors: ['Reviewer'], ignoreOwnComments: false },
      { liveIds: ['sess-1'] },
    )
    service.watch({ ...WATCH, id: 'extra', conditions: ['merged'], notifyChanges: true })
    await pollTwo(
      service,
      snapshot({ issueComments: 1, conversation: [] }),
      snapshot({ issueComments: 2, conversation: [THEIRS] }),
      [[], [THEIRS]],
    )
    expect(delivered.get('sess-1')).toBeUndefined()
    await dispose()
  })

  it('counts comments when the authenticated login cannot be resolved', async () => {
    const { service, delivered, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.login = undefined
    service.watch({ ...WATCH, id: 'unresolved', conditions: ['merged'], notifyChanges: true })
    await pollTwo(
      service,
      snapshot({ issueComments: 1, conversation: [] }),
      snapshot({ issueComments: 2, conversation: [MINE] }),
      [[], [MINE]],
    )
    expect(delivered.get('sess-1')).toHaveLength(1)
    await dispose()
  })

  it('reports the effective flag in pr_watch_list and persists the override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prw-filter-'))
    const file = join(dir, 'state.json')
    try {
      const first = await mounted({ stateFile: file })
      first.service.watch({ ...WATCH, id: 'default', conditions: ['merged'] })
      first.service.watch({ ...WATCH, id: 'opted-out', conditions: ['merged'], ignoreOwnComments: false })
      expect(first.service.list().map((w) => [w.id, w.ignoreOwnComments])).toEqual([
        ['default', true],
        ['opted-out', false],
      ])
      await first.dispose()
      const second = await mounted({ stateFile: file })
      expect(second.service.list().map((w) => [w.id, w.ignoreOwnComments])).toEqual([
        ['default', true],
        ['opted-out', false],
      ])
      await second.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps own comments as changes when the config disables the filter', async () => {
    const { service, delivered, dispose } = await mounted(
      { ignoreOwnComments: false },
      { liveIds: ['sess-1'] },
    )
    service.watch({ ...WATCH, id: 'cfg-off', conditions: ['merged'], notifyChanges: true })
    expect(service.list()[0]!.ignoreOwnComments).toBe(false)
    await pollTwo(
      service,
      snapshot({ issueComments: 1, conversation: [] }),
      snapshot({ issueComments: 2, conversation: [MINE] }),
      [[], [MINE]],
    )
    expect(delivered.get('sess-1')).toHaveLength(1)
    await dispose()
  })
})

describe('rate-limit handling', () => {
  const RATE_LIMIT = 'gh: API rate limit already exceeded for user ID 75373981.'

  it('recognizes primary and secondary rate-limit failures', () => {
    expect(isRateLimitMessage(RATE_LIMIT)).toBe(true)
    expect(isRateLimitMessage('You have exceeded a secondary rate limit')).toBe(true)
    expect(isRateLimitMessage('graphql_rate_limit')).toBe(true)
    expect(isRateLimitMessage('pull request not found')).toBe(false)
    expect(isRateLimitMessage('Command failed: network timeout')).toBe(false)
  })

  it('pauses every watch on the first rate limit and resumes once the pause expires', async () => {
    const { service, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.clock = 1_000_000
    service.watch({ ...WATCH, id: 'a', conditions: ['merged'] })
    service.watch({ ...WATCH, id: 'b', conditions: ['merged'] })
    let calls = 0
    service.fetchImpl = async () => {
      calls += 1
      throw new Error(RATE_LIMIT)
    }
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    // The cycle stops at the first throttled watch instead of spending the rest.
    expect(calls).toBe(1)
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(1)
    // Past the 120s pause and the 30s per-watch backoff: both watches poll again.
    service.clock = 1_000_000 + 121_000
    service.fetchImpl = async () => { calls += 1; return snapshot() }
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(3)
    await dispose()
  })

  it('doubles the pause on a consecutive rate limit', async () => {
    const { service, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.clock = 1_000_000
    service.watch({ ...WATCH, id: 'a', conditions: ['merged'] })
    service.fetchImpl = async () => { throw new Error(RATE_LIMIT) }
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    service.clock = 1_000_000 + 121_000
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    // Second report doubles the pause to 240s, so 200s later is still paused.
    const paused = service.clock + 200_000
    let calls = 0
    service.fetchImpl = async () => { calls += 1; return snapshot() }
    service.clock = paused
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(0)
    service.clock = paused + 41_000
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(1)
    await dispose()
  })

  it('a successful poll resets the pause length', async () => {
    const { service, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.clock = 1_000_000
    service.watch({ ...WATCH, id: 'a', conditions: ['merged'] })
    let calls = 0
    service.fetchImpl = async () => {
      calls += 1
      if (calls === 1 || calls === 3) throw new Error(RATE_LIMIT)
      return snapshot()
    }
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    service.clock = 1_000_000 + 121_000
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(2)
    // A second report after the success starts from the base pause again.
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(3)
    service.clock = 1_000_000 + 121_000 + 121_000
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(calls).toBe(4)
    await dispose()
  })

  it('paces watch polls inside a cycle and does not pace a single watch', async () => {
    const { service, dispose } = await mounted({}, { liveIds: ['sess-1'] })
    service.watch({ ...WATCH, id: 'a' })
    service.fetchImpl = async () => snapshot()
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(service.paceCalls).toBe(0)
    service.watch({ ...WATCH, id: 'b' })
    await (service as unknown as { pollAll(): Promise<void> }).pollAll()
    expect(service.paceCalls).toBe(1)
    await dispose()
  })
})
