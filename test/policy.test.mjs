/**
 * Behavioural tests for `dsh-llm-retry-boost`.
 *
 * The plugin is exercised through a faithful miniature of the Cordis
 * `agent/request-error` waterfall: listeners run outermost-first, `prepend`
 * puts ours in front, and `next()` walks the rest of the chain exactly like
 * `EventsService.waterfall`. Timing is injected, so the tests assert the exact
 * backoff curve without waiting.
 *
 * Run with `node test/policy.test.mjs`.
 */

import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import {
  DEFAULT_NORMAL_BACKOFF,
  computeDelay,
  defaultBackoff,
  defaultBudget,
  isTransientFailure,
  policyKeyOf,
  resolveSettings,
} from '../lib/policy.js'

/** Ordered list of `[name, fn]` cases. */
const cases = []

/**
 * Register one test case.
 * @param name - case name.
 * @param fn - async body.
 */
function test(name, fn) {
  cases.push([name, fn])
}

/**
 * Build a fake Cordis context: `on` with prepend, `effect`, `logger`, and a
 * faithful waterfall dispatch.
 * @returns the fake context plus test helpers.
 */
function createCtx() {
  const hooks = new Map()
  const cleanups = []
  const logs = []

  const logger = {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  }

  const ctx = {
    logger,
    on(event, listener, options) {
      const list = hooks.get(event) ?? []
      if (options && typeof options === 'object' && options.prepend) list.unshift(listener)
      else list.push(listener)
      hooks.set(event, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
        return index >= 0
      }
    },
    effect(factory) {
      const cleanup = factory()
      cleanups.push(cleanup)
      return () => {}
    },
    dispatchSession(session, event) {
      for (const listener of [...(hooks.get('session/event') ?? [])]) listener(session, event)
    },
    async dispatchRequestError(payload) {
      const chain = [...(hooks.get('agent/request-error') ?? [])]
      const invoke = (index) => async () => {
        if (index >= chain.length) return undefined
        return chain[index](payload, invoke(index + 1))
      }
      return invoke(0)()
    },
    listenerCount(event) {
      return (hooks.get(event) ?? []).length
    },
    disposeAll() {
      for (const cleanup of cleanups.splice(0)) {
        try {
          const result = cleanup()
          if (result && typeof result.then === 'function') result.catch(() => {})
        } catch {
          /* disposal failures are the caller's problem in tests */
        }
      }
    },
  }

  return { ctx, logs }
}

/**
 * Build a fake agent whose session records appends.
 * @param id - session id.
 * @returns the agent, its session, and the recorded events.
 */
function createAgent(id = 'session-1') {
  const events = []
  const session = {
    id,
    append(type, data) {
      events.push({ type, data })
      return { type, data }
    },
  }
  return { agent: { id, session }, session, events }
}

/**
 * Build an `agent/request-error` payload.
 * @param agent - the failing agent.
 * @param overrides - payload overrides.
 * @returns the payload.
 */
function makePayload(agent, overrides = {}) {
  const controller = new AbortController()
  return {
    agent,
    turn: 1,
    step: 2,
    provider: 'deepseek-account',
    failure: { code: 'SERVER', status: 503, message: 'engine overloaded' },
    retryPolicy: {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10000,
      jitterRatio: 0.1,
    },
    signal: controller.signal,
    ...overrides,
  }
}

/**
 * Build injectable timing seams.
 * @param options - `randomValue`, `uuidValues`, `waitResult`.
 * @returns internals plus the recorded delays.
 */
function createInternals(options = {}) {
  const delays = []
  let uuidIndex = 0
  const uuidValues = options.uuidValues ?? ['retry-chain-1']
  return {
    delays,
    internals: {
      random: () => options.randomValue ?? 0.5,
      uuid: () => uuidValues[Math.min(uuidIndex++, uuidValues.length - 1)],
      delay: async (delayMs) => {
        delays.push(delayMs)
        return options.waitResult ?? true
      },
    },
  }
}

/** Settings used when a test wants zero jitter and exact delays. */
const EXACT = {
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  jitterRatio: 0,
  logRetries: false,
}

// ---------------------------------------------------------------------------
// Policy surface
// ---------------------------------------------------------------------------

test('defaults reproduce the shipped classification and an unlimited budget', () => {
  const settings = resolveSettings(undefined)
  assert.equal(settings.enabled, true)
  assert.equal(settings.maxRetries, 0)
  assert.equal(settings.initialDelayMs, 1000)
  assert.equal(settings.maxDelayMs, 60000)
  assert.equal(settings.configErrorBehavior, 'delegate')
  assert.deepEqual([...settings.codeSet].sort(), ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  assert.ok(settings.statusSet.has(503))
})

test('unknown keys and malformed values fail loudly', () => {
  assert.throws(() => resolveSettings({ retryableCode: ['SERVER'] }), /unknown config key "retryableCode"/)
  assert.throws(() => resolveSettings({ jitterRatio: 2 }), /"jitterRatio"/)
  assert.throws(() => resolveSettings({ initialDelayMs: 10 }), /"initialDelayMs"/)
  assert.throws(() => resolveSettings({ maxRetries: -1 }), /"maxRetries"/)
  assert.throws(() => resolveSettings({ configErrorBehavior: 'never' }), /"configErrorBehavior"/)
  assert.throws(() => resolveSettings({ retryableHttpStatuses: [99] }), /"retryableHttpStatuses"/)
  assert.throws(() => resolveSettings('nope'), /must be a mapping/)
})

test('classification is an allow-list with HTTP status support', () => {
  const settings = resolveSettings({})
  assert.equal(isTransientFailure({ code: 'SERVER' }, settings), true)
  assert.equal(isTransientFailure({ code: 'server' }, settings), true)
  assert.equal(isTransientFailure({ code: 'HTTP_503' }, settings), true)
  assert.equal(isTransientFailure({ code: 'HTTP_429' }, settings), true)
  assert.equal(isTransientFailure({ code: 'MYSTERY', status: 502 }, settings), true)
  assert.equal(isTransientFailure({ code: 'HTTP_400' }, settings), false)
  assert.equal(isTransientFailure({ code: 'AUTH', status: 401 }, settings), false)
  assert.equal(isTransientFailure({ code: 'MISSING_CREDENTIAL' }, settings), false)
  assert.equal(isTransientFailure({ code: 'QUOTA' }, settings), false)
  assert.equal(isTransientFailure({ code: 'INVALID_REQUEST' }, settings), false)
  assert.equal(isTransientFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }, settings), false)
  assert.equal(isTransientFailure({ code: 'ABORTED' }, settings), false)
})

test('backoff doubles from initialDelayMs and stops at maxDelayMs', () => {
  const settings = resolveSettings(EXACT)
  const curve = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => computeDelay(attempt, {}, settings, () => 0.5))
  assert.deepEqual(curve, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
})

test('jitter stays inside the configured symmetric band', () => {
  const settings = resolveSettings({ ...EXACT, jitterRatio: 0.2 })
  assert.equal(computeDelay(1, {}, settings, () => 0), 800)
  assert.equal(computeDelay(1, {}, settings, () => 1), 1200)
  assert.equal(computeDelay(1, {}, settings, () => 0.5), 1000)
})

test('a provider Retry-After wins but never exceeds maxDelayMs', () => {
  const settings = resolveSettings({ ...EXACT, maxDelayMs: 45000 })
  assert.equal(computeDelay(3, { providerRetryAfterMs: 30000 }, settings), 30000)
  assert.equal(computeDelay(3, { providerRetryAfterMs: 900000 }, settings), 45000)
  assert.equal(computeDelay(3, { providerRetryAfterMs: 0 }, settings), 4000)
  const ignoring = resolveSettings({ ...EXACT, respectRetryAfter: false })
  assert.equal(computeDelay(3, { providerRetryAfterMs: 30000 }, ignoring), 4000)
})

test('the shipped budget and backoff are read from the resolved policy', () => {
  const normal = { mode: 'normal', maxRetries: 3, initialDelayMs: 700, maxDelayMs: 9000, jitterRatio: 0.3 }
  assert.equal(defaultBudget(normal), 3)
  assert.equal(defaultBudget({ mode: 'always', initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 }), 5)
  assert.deepEqual(defaultBackoff(normal, true), { initialDelayMs: 700, maxDelayMs: 9000, jitterRatio: 0.3, respectRetryAfter: true })
  assert.deepEqual(defaultBackoff(undefined, false), { ...DEFAULT_NORMAL_BACKOFF, respectRetryAfter: false })
})

test('the policy key changes with behaviour and ignores cosmetic keys', () => {
  const base = policyKeyOf(resolveSettings({}))
  assert.equal(policyKeyOf(resolveSettings({ logRetries: false, enabled: false })), base)
  assert.notEqual(policyKeyOf(resolveSettings({ maxDelayMs: 30000 })), base)
  assert.notEqual(policyKeyOf(resolveSettings({ retryableCodes: ['SERVER'] })), base)
})

// ---------------------------------------------------------------------------
// Waterfall behaviour
// ---------------------------------------------------------------------------

test('a transient failure retries forever with a growing, capped delay', async () => {
  const { ctx, logs } = createCtx()
  const { delays, internals } = createInternals()
  apply(ctx, EXACT, internals)

  const { agent, events } = createAgent()
  const expected = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]

  for (const _ of expected) {
    const action = await ctx.dispatchRequestError(makePayload(agent))
    assert.deepEqual(action, { kind: 'retry' })
  }

  assert.deepEqual(delays, expected)

  const scheduled = events.filter((event) => event.type === 'llm/retry')
  const started = events.filter((event) => event.type === 'llm/retry-started')
  assert.equal(scheduled.length, expected.length)
  assert.equal(started.length, expected.length)
  assert.deepEqual(scheduled.map((event) => event.data.retry), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(started.map((event) => event.data.retry), [1, 2, 3, 4, 5, 6, 7, 8, 9])

  const first = scheduled[0].data
  assert.equal(first.mode, 'always')
  assert.equal(first.provider, 'deepseek-account')
  assert.equal(first.turn, 1)
  assert.equal(first.step, 2)
  assert.equal(first.retryId, 'retry-chain-1')
  assert.equal('maxRetries' in first, false)
  assert.equal(first.failure.code, 'SERVER')
  assert.equal(first.policyKey, policyKeyOf(resolveSettings(EXACT)))

  assert.equal(new Set(scheduled.map((event) => event.data.retryId)).size, 1)
  assert.ok(logs.length >= 0)
})

test('step/start and turn/end reset the attempt chain', async () => {
  const { ctx } = createCtx()
  const { delays, internals } = createInternals({ uuidValues: ['chain-a', 'chain-b'] })
  apply(ctx, EXACT, internals)

  const { agent, session, events } = createAgent()
  await ctx.dispatchRequestError(makePayload(agent))
  await ctx.dispatchRequestError(makePayload(agent))
  assert.deepEqual(delays, [1000, 2000])

  ctx.dispatchSession(session, { type: 'step/start' })
  await ctx.dispatchRequestError(makePayload(agent))
  assert.deepEqual(delays, [1000, 2000, 1000])

  ctx.dispatchSession(session, { type: 'turn/end' })
  await ctx.dispatchRequestError(makePayload(agent))
  assert.deepEqual(delays, [1000, 2000, 1000, 1000])

  const scheduled = events.filter((event) => event.type === 'llm/retry').map((event) => event.data)
  assert.deepEqual(scheduled.map((event) => event.retry), [1, 2, 1, 1])
  assert.deepEqual(scheduled.map((event) => event.retryId), ['chain-a', 'chain-a', 'chain-b', 'chain-b'])
})

test('a configuration failure is delegated to the shipped policy untouched', async () => {
  const { ctx } = createCtx()
  const { delays, internals } = createInternals()
  apply(ctx, EXACT, internals)

  let downstream = 0
  ctx.on('agent/request-error', () => {
    downstream += 1
    return undefined
  })

  const { agent, events } = createAgent()
  const action = await ctx.dispatchRequestError(makePayload(agent, {
    failure: { code: 'AUTH', status: 401, message: 'invalid api key' },
  }))

  assert.equal(action, undefined)
  assert.equal(downstream, 1)
  assert.deepEqual(delays, [])
  assert.deepEqual(events, [])
})

test('bounded mode retries configuration failures with the shipped budget and backoff', async () => {
  const { ctx } = createCtx()
  const { delays, internals } = createInternals()
  apply(ctx, { ...EXACT, configErrorBehavior: 'bounded' }, internals)

  let downstream = 0
  ctx.on('agent/request-error', () => {
    downstream += 1
    return undefined
  })

  const { agent, events } = createAgent()
  const payload = () => makePayload(agent, {
    failure: { code: 'AUTH', status: 401, message: 'invalid api key' },
  })

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.deepEqual(await ctx.dispatchRequestError(payload()), { kind: 'retry' })
  }
  assert.deepEqual(await ctx.dispatchRequestError(payload()), undefined)
  assert.equal(downstream, 1)

  // The provider policy's own backoff (500ms doubling, capped at 10s), not the boost curve.
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000])
  const scheduled = events.filter((event) => event.type === 'llm/retry').map((event) => event.data)
  assert.equal(scheduled.length, 5)
  assert.deepEqual(scheduled.map((event) => event.retry), [1, 2, 3, 4, 5])
  assert.ok(scheduled.every((event) => event.mode === 'normal' && event.maxRetries === 5))
})

test('a finite maxRetries ends the step instead of piling on the shipped budget', async () => {
  const { ctx } = createCtx()
  const { delays, internals } = createInternals()
  apply(ctx, { ...EXACT, maxRetries: 2 }, internals)

  let downstream = 0
  ctx.on('agent/request-error', () => {
    downstream += 1
    return undefined
  })

  const { agent, events } = createAgent()
  assert.deepEqual(await ctx.dispatchRequestError(makePayload(agent)), { kind: 'retry' })
  assert.deepEqual(await ctx.dispatchRequestError(makePayload(agent)), { kind: 'retry' })
  assert.equal(await ctx.dispatchRequestError(makePayload(agent)), undefined)
  assert.equal(downstream, 0)
  assert.deepEqual(delays, [1000, 2000])
  const scheduled = events.filter((event) => event.type === 'llm/retry').map((event) => event.data)
  assert.deepEqual(scheduled.map((event) => [event.mode, event.maxRetries]), [['normal', 2], ['normal', 2]])
})

test('a malformed policy can never produce a NaN or overflowing delay', () => {
  for (const settings of [{}, { initialDelayMs: Number.NaN }, { maxDelayMs: Infinity, jitterRatio: Number.NaN }]) {
    const delay = computeDelay(7, {}, settings, () => 0.5)
    assert.ok(Number.isFinite(delay) && delay > 0, `delay ${delay} must be a positive finite number`)
    assert.ok(delay <= 2 ** 31 - 1, `delay ${delay} must fit setTimeout`)
  }
})

test('the real timer path re-runs after the wait and stops on abort', async () => {
  const first = createCtx()
  apply(first.ctx, { ...EXACT, initialDelayMs: 100, maxDelayMs: 1000, logRetries: false })
  const { agent } = createAgent()
  const started = Date.now()
  assert.deepEqual(await first.ctx.dispatchRequestError(makePayload(agent)), { kind: 'retry' })
  assert.ok(Date.now() - started >= 90, 'the real wait must elapse before the retry')

  const second = createCtx()
  apply(second.ctx, { ...EXACT, initialDelayMs: 5000, maxDelayMs: 5000, logRetries: false })
  const abortable = createAgent()
  const controller = new AbortController()
  const pending = second.ctx.dispatchRequestError(makePayload(abortable.agent, { signal: controller.signal }))
  setTimeout(() => controller.abort(), 20)
  const abortedAt = Date.now()
  assert.equal(await pending, undefined)
  assert.ok(Date.now() - abortedAt < 1000, 'abort must interrupt the wait instead of blocking it')
  assert.equal(abortable.events.filter((event) => event.type === 'llm/retry').length, 1)
  assert.equal(abortable.events.filter((event) => event.type === 'llm/retry-started').length, 0)
})

test('a failure without a provider retry policy is delegated', async () => {
  const { ctx } = createCtx()
  const { delays, internals } = createInternals()
  apply(ctx, EXACT, internals)

  let downstream = 0
  ctx.on('agent/request-error', () => {
    downstream += 1
    return undefined
  })

  const { agent, events } = createAgent()
  const action = await ctx.dispatchRequestError(makePayload(agent, { retryPolicy: undefined }))
  assert.equal(action, undefined)
  assert.equal(downstream, 1)
  assert.deepEqual(delays, [])
  assert.deepEqual(events, [])
})

test('an aborted turn or an ABORTED code never schedules a retry', async () => {
  const { ctx } = createCtx()
  const { delays, internals } = createInternals()
  apply(ctx, EXACT, internals)

  let downstream = 0
  ctx.on('agent/request-error', () => {
    downstream += 1
    return undefined
  })

  const { agent, events } = createAgent()

  const aborted = makePayload(agent)
  aborted.signal = AbortSignal.abort()
  assert.equal(await ctx.dispatchRequestError(aborted), undefined)

  assert.equal(await ctx.dispatchRequestError(makePayload(agent, {
    failure: { code: 'ABORTED', message: 'cancelled by user' },
  })), undefined)

  assert.equal(downstream, 2)
  assert.deepEqual(delays, [])
  assert.deepEqual(events, [])
})

test('cancellation during the backoff wait stops before re-running the step', async () => {
  const { ctx } = createCtx()
  const { delays, internals } = createInternals({ waitResult: false })
  apply(ctx, EXACT, internals)

  const { agent, events } = createAgent()
  assert.equal(await ctx.dispatchRequestError(makePayload(agent)), undefined)
  assert.deepEqual(delays, [1000])
  assert.equal(events.filter((event) => event.type === 'llm/retry').length, 1)
  assert.equal(events.filter((event) => event.type === 'llm/retry-started').length, 0)
})

test('disabled config registers no listeners at all', async () => {
  const { ctx, logs } = createCtx()
  apply(ctx, { enabled: false })
  assert.equal(ctx.listenerCount('agent/request-error'), 0)
  assert.equal(ctx.listenerCount('session/event'), 0)
  assert.equal(await ctx.dispatchRequestError(makePayload(createAgent().agent)), undefined)
  assert.ok(logs.some(([, message]) => message.includes('disabled by config')))
})

test('disposal removes both listeners', async () => {
  const { ctx } = createCtx()
  const { internals } = createInternals()
  apply(ctx, EXACT, internals)
  assert.equal(ctx.listenerCount('agent/request-error'), 1)
  assert.equal(ctx.listenerCount('session/event'), 1)

  ctx.disposeAll()
  assert.equal(ctx.listenerCount('agent/request-error'), 0)
  assert.equal(ctx.listenerCount('session/event'), 0)
  assert.equal(await ctx.dispatchRequestError(makePayload(createAgent().agent)), undefined)
})

test('our listener is prepended, so it owns the failure before the shipped executor', async () => {
  const { ctx } = createCtx()
  const { internals } = createInternals()
  const order = []

  // The shipped executor registers itself first, without prepend.
  ctx.on('agent/request-error', async () => {
    order.push('shipped')
    return undefined
  })

  apply(ctx, EXACT, internals)
  const { agent } = createAgent()
  await ctx.dispatchRequestError(makePayload(agent))
  assert.deepEqual(order, [])

  await ctx.dispatchRequestError(makePayload(agent, {
    failure: { code: 'AUTH', status: 401, message: 'invalid api key' },
  }))
  assert.deepEqual(order, ['shipped'])
})

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  not ok  ${name}`)
    console.error(error)
  }
}

console.log(`\n${cases.length - failures}/${cases.length} passed`)
if (failures > 0) process.exitCode = 1
