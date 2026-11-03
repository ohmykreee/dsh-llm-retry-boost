/**
 * `dsh-llm-retry-boost` — unlimited, capped-backoff recovery for transient
 * model-request failures.
 *
 * Why this exists
 * ---------------
 * The shipped `@deepseek-ai/dsh-llm-retry` executor applies each provider's
 * `retryPolicy`. Its default is *normal* mode: five attempts for
 * `EMPTY_RESPONSE | RATE_LIMIT | SERVER | TIMEOUT | TRANSPORT`, then the turn
 * ends with the provider error. A provider that stays overloaded longer than
 * that budget turns a recoverable wait into a failed turn.
 *
 * Setting `retryPolicy.mode: always` removes the limit but also removes the
 * classification: it retries permanent configuration failures — a bad API key,
 * an unknown model, a rejected request — forever, which hides the error and
 * burns requests.
 *
 * This plugin keeps the classification and replaces only the budget:
 *
 *   - an allow-listed *transient* failure retries without an attempt limit,
 *     waiting `initialDelayMs * 2^(attempt-1)` with jitter, capped at
 *     `maxDelayMs` forever (or `maxRetries` times when configured);
 *   - every other failure — including every configuration error — is delegated
 *     to the shipped policy unchanged (`configErrorBehavior: delegate`, the
 *     default), or retried under the shipped *finite* budget and backoff when
 *     the operator opts into `bounded`.
 *
 * Composition
 * -----------
 * The listener is registered with `prepend: true` on the
 * `agent/request-error` waterfall, so it is outermost regardless of plugin
 * load order: it sees the failure before the shipped executor and either owns
 * the decision or calls `next()` to hand the failure back untouched.
 *
 * Durability
 * ----------
 * Each scheduled attempt is recorded with the shipped `llm/retry` event (mode
 * `always` or `normal`) before the timer starts, and `llm/retry-started`
 * immediately before the attempt re-runs, so the log tells the same story the
 * shipped executor would. Attempt numbering itself lives in memory — a derived
 * cache, not a source of truth — and resets on `step/start` and `turn/end`
 * exactly like the shipped projection, so a restart can only restart the
 * backoff curve, never break the log.
 *
 * @module dsh-llm-retry-boost
 */

import { randomUUID } from 'node:crypto'

import {
  computeDelay,
  defaultBackoff,
  defaultBudget,
  isTransientFailure,
  policyKeyOf,
  resolveSettings,
} from './policy.js'

/** Plugin name used by the loader and by log lines. */
export const name = 'llm-retry-boost'

/** Upper bound on tracked sessions; chains are evicted oldest-first. */
const MAX_TRACKED_SESSIONS = 256

/** Largest delay `setTimeout` accepts before overflowing into an immediate fire. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/**
 * Wait one timer slice, resolving `false` as soon as `signal` aborts.
 * @param delayMs - slice duration in milliseconds, at most {@link MAX_TIMER_DELAY_MS}.
 * @param signal - turn/deactivation signal.
 * @returns `true` when the slice elapsed, `false` when aborted.
 */
function waitSlice(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Wait for `delayMs` in timer-sized slices, resolving `false` on abort.
 *
 * Slicing keeps an oversized `maxDelayMs` meaningful: `setTimeout` fires
 * immediately for delays above 2^31-1 ms, which would otherwise turn a very
 * long backoff into a hot retry loop.
 *
 * @param delayMs - wait duration in milliseconds.
 * @param signal - turn/deactivation signal.
 * @returns `true` when the full wait elapsed, `false` when aborted.
 */
async function cancellableDelay(delayMs, signal) {
  let remaining = Number.isFinite(delayMs) ? Math.max(0, Math.round(delayMs)) : 0
  do {
    if (signal?.aborted) return false
    const slice = Math.min(remaining, MAX_TIMER_DELAY_MS)
    if (!await waitSlice(slice, signal)) return false
    remaining -= slice
  } while (remaining > 0)
  return true
}

/**
 * Resolve a logger that never throws.
 * @param ctx - plugin context.
 * @returns a logger-like object with at least `warn`.
 */
function resolveLogger(ctx) {
  try {
    const candidate = ctx?.logger
    if (candidate && typeof candidate.warn === 'function') return candidate
    if (typeof candidate === 'function') {
      const scoped = candidate(name)
      if (scoped && typeof scoped.warn === 'function') return scoped
    }
  } catch {
    /* logging must never break retry recovery */
  }
  return console
}

/**
 * Mount the retry policy.
 *
 * @param ctx - Cordis context of this loader entry.
 * @param config - raw row config; see `resolveSettings` for the accepted keys.
 * @param internals - test seams: `random`, `delay`, `uuid`.
 */
export function apply(ctx, config = {}, internals = {}) {
  /**
   * Re-read the live configuration.
   *
   * Volatile fields arrive as references the Host updates in place, so a value
   * read once at mount would never follow an edit made on the Plugins page.
   * Reading per decision costs one small object walk per failed attempt.
   *
   * @returns the resolved settings for the current values.
   */
  const readSettings = () => resolveSettings(config)
  const initial = readSettings()
  const logger = resolveLogger(ctx)

  const log = (level, message) => {
    try {
      if (typeof logger[level] === 'function') logger[level](message)
    } catch {
      /* logging must never break retry recovery */
    }
  }

  if (!initial.enabled) {
    log('info', 'llm-retry-boost: disabled by config; the shipped retry policy applies unchanged')
  }

  const random = typeof internals.random === 'function' ? internals.random : Math.random
  const sleep = typeof internals.delay === 'function' ? internals.delay : cancellableDelay
  const uuid = typeof internals.uuid === 'function' ? internals.uuid : () => randomUUID()

  /** `sessionId -> provider -> { retry, retryId }`: a derived, disposable cache. */
  const chains = new Map()
  const lifetime = new AbortController()
  const active = new Set()

  log(
    'info',
    'llm-retry-boost: mounted — retryable codes '
    + `[${[...initial.codeSet].join(', ')}], retryable HTTP statuses [${[...initial.statusSet].join(', ')}], `
    + `attempts ${initial.maxRetries === 0 ? 'unlimited' : initial.maxRetries}, `
    + `delay ${initial.initialDelayMs}ms×2^n capped at ${initial.maxDelayMs}ms, `
    + `non-transient failures: ${initial.configErrorBehavior === 'bounded' ? 'shipped finite budget and backoff' : 'shipped policy'}`,
  )

  /**
   * Read (or start) the retry chain of one provider inside one session.
   * @param agent - the agent whose step failed.
   * @param provider - provider route name.
   * @returns the mutable chain record.
   */
  function chainOf(agent, provider) {
    const sessionId = agent?.session?.id ?? agent?.id ?? 'unknown'
    let perSession = chains.get(sessionId)
    if (!perSession) {
      if (chains.size >= MAX_TRACKED_SESSIONS) {
        const oldest = chains.keys().next().value
        chains.delete(oldest)
      }
      perSession = new Map()
      chains.set(sessionId, perSession)
    }
    let chain = perSession.get(provider)
    if (!chain) {
      chain = { retry: 0, retryId: uuid() }
      perSession.set(provider, chain)
    }
    return chain
  }

  /**
   * Decide what to do with one failed attempt, without side effects.
   *
   * @param payload - the `agent/request-error` payload.
   * @returns `{ kind: 'delegate' }`, `{ kind: 'stop' }`, or a retry plan.
   */
  function planRetry(payload) {
    const settings = readSettings()
    if (!settings.enabled) return { kind: 'delegate' }

    const { agent, provider, failure, retryPolicy: policy, signal } = payload ?? {}
    if (typeof provider !== 'string' || !failure || typeof failure.code !== 'string') {
      return { kind: 'delegate' }
    }
    if (policy === undefined || policy === null) return { kind: 'delegate' }
    if (signal?.aborted || lifetime.signal.aborted) return { kind: 'delegate' }
    if (failure.code.toUpperCase() === 'ABORTED') return { kind: 'delegate' }

    if (!isTransientFailure(failure, settings)) {
      // Configuration-class failure: the plugin's own budget does not apply.
      if (settings.configErrorBehavior !== 'bounded') return { kind: 'delegate' }
      const budget = defaultBudget(policy)
      const chain = chainOf(agent, provider)
      const attempt = chain.retry + 1
      if (budget <= 0 || attempt > budget) return { kind: 'delegate' }
      return {
        kind: 'retry',
        chain,
        attempt,
        mode: 'normal',
        budget,
        settings,
        backoff: defaultBackoff(policy, settings.respectRetryAfter),
      }
    }

    const chain = chainOf(agent, provider)
    const attempt = chain.retry + 1
    if (settings.maxRetries > 0 && attempt > settings.maxRetries) {
      return { kind: 'stop', exhausted: true, settings }
    }
    return {
      kind: 'retry',
      chain,
      attempt,
      mode: settings.maxRetries > 0 ? 'normal' : 'always',
      budget: settings.maxRetries,
      settings,
      backoff: settings,
    }
  }

  /**
   * Record one scheduled attempt, wait, then let the loop re-run the step.
   *
   * @param payload - the `agent/request-error` payload.
   * @param plan - the retry plan from `planRetry`.
   * @returns `{ kind: 'retry' }` when the step must re-run, `undefined` when cancelled.
   */
  async function schedule(payload, plan) {
    const { agent, turn, step, provider, failure, signal } = payload
    const { chain, settings } = plan
    const delayMs = computeDelay(plan.attempt, failure, plan.backoff, random)
    const fused = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
    if (fused.aborted) return undefined

    const base = {
      retryId: chain.retryId,
      turn,
      step,
      provider,
      mode: plan.mode,
      policyKey: policyKeyOf(settings),
      retry: plan.attempt,
      delayMs,
      failure,
    }
    const data = plan.mode === 'normal' ? { ...base, maxRetries: plan.budget } : base

    agent.session.append('llm/retry', data)
    chain.retry = plan.attempt

    if (settings.logRetries) {
      log(
        'warn',
        `llm-retry-boost: ${provider} ${failure.code} (turn ${turn}, step ${step}) — `
        + `attempt #${plan.attempt}${plan.budget > 0 ? `/${plan.budget}` : ''} in ${Math.round(delayMs)}ms`,
      )
    }

    if (!await sleep(delayMs, fused)) return undefined

    agent.session.append('llm/retry-started', {
      retryId: chain.retryId,
      turn,
      step,
      retry: plan.attempt,
    })
    return { kind: 'retry' }
  }

  /**
   * Handle one failed model-request attempt.
   * @param payload - the `agent/request-error` payload.
   * @param next - the rest of the waterfall, including the shipped executor.
   * @returns the recovery action for the loop.
   */
  async function handle(payload, next) {
    let plan
    try {
      plan = planRetry(payload)
    } catch (error) {
      log('warn', `llm-retry-boost: could not evaluate the failure (${String(error)}); delegating`)
      return next()
    }

    if (plan.kind === 'delegate') return next()
    if (plan.kind === 'stop') {
      log(
        'warn',
        `llm-retry-boost: ${payload?.provider} ${payload?.failure?.code} reached `
        + `maxRetries=${plan.settings.maxRetries}; ending the step with the provider failure`,
      )
      return undefined
    }

    try {
      return await schedule(payload, plan)
    } catch (error) {
      log('warn', `llm-retry-boost: retry scheduling failed (${String(error)}); delegating`)
      return next()
    }
  }

  // Chain boundaries: a new step or a finished turn starts a fresh budget,
  // matching the shipped projection's reset rule so both views agree.
  const disposeReset = ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'step/start' || event?.type === 'turn/end') chains.delete(session?.id)
    } catch {
      /* a reset failure must not break the append feed */
    }
  })

  // `prepend` keeps this listener outermost whatever order bundles load in.
  const disposeError = ctx.on('agent/request-error', (payload, next) => {
    const tracked = handle(payload, next).finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }, { prepend: true })

  ctx.effect(() => () => {
    disposeReset()
    disposeError()
    lifetime.abort(new Error('llm-retry-boost plugin disposed'))
  }, 'llm-retry-boost: abort and drain active backoff')
}
