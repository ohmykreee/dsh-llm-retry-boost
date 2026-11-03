/**
 * Pure retry-policy helpers for `dsh-llm-retry-boost`.
 *
 * Everything here is free of Cordis, Node services, and I/O so the decision
 * logic can be unit-tested directly. `lib/index.js` owns the plugin wiring.
 *
 * @module dsh-llm-retry-boost/policy
 */

/** Exponent ceiling; `2 ** 30` ms already dwarfs any sane `maxDelayMs`. */
export const MAX_EXPONENT = 30

/**
 * Failure codes retried without an attempt limit by default.
 *
 * These are exactly the provider-side transients the shipped normal policy
 * already treats as retryable (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`,
 * `TIMEOUT`, `TRANSPORT`), so the plugin only replaces the *budget*, never the
 * classification, of the built-in policy.
 */
export const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/**
 * HTTP statuses whose `HTTP_<status>` failure code stays retryable.
 *
 * A provider that cannot map an overload response to `SERVER`/`RATE_LIMIT`
 * still surfaces `HTTP_503`; 4xx statuses are deliberately absent so a bad
 * request keeps failing fast.
 */
export const DEFAULT_RETRYABLE_HTTP_STATUSES = Object.freeze([408, 425, 429, 500, 502, 503, 504])

/** Built-in normal-mode budget used when a provider policy is not `normal`. */
export const DEFAULT_NORMAL_BUDGET = 5

/**
 * Built-in normal-mode backoff, used only when a provider policy is not
 * `normal` and a non-transient failure falls back to `bounded` retries.
 */
export const DEFAULT_NORMAL_BACKOFF = Object.freeze({
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0.1,
})

/** Lowest accepted base delay: prevents an accidental zero-delay hot loop. */
export const MIN_INITIAL_DELAY_MS = 100

/** Accepted `configErrorBehavior` values. */
export const CONFIG_ERROR_BEHAVIORS = Object.freeze(['delegate', 'bounded'])

/** Every accepted config key. */
export const SETTINGS_KEYS = Object.freeze([
  'enabled',
  'retryableCodes',
  'retryableHttpStatuses',
  'maxRetries',
  'initialDelayMs',
  'maxDelayMs',
  'jitterRatio',
  'respectRetryAfter',
  'configErrorBehavior',
  'logRetries',
])

/** Defaults applied to every omitted key. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Master switch; `false` leaves the shipped retry policy untouched. */
  enabled: true,
  /** Failure codes retried under the plugin's own budget. */
  retryableCodes: DEFAULT_RETRYABLE_CODES,
  /** HTTP statuses (matching `HTTP_<status>` or `failure.status`) kept transient. */
  retryableHttpStatuses: DEFAULT_RETRYABLE_HTTP_STATUSES,
  /** Attempt budget for transient failures; `0` means unlimited. */
  maxRetries: 0,
  /** First backoff delay, doubled per attempt. */
  initialDelayMs: 1000,
  /** Ceiling for every computed delay. */
  maxDelayMs: 60000,
  /** Symmetric jitter ratio applied to local backoff (`0` disables it). */
  jitterRatio: 0.1,
  /** Honour a provider `Retry-After`, clamped to `maxDelayMs`. */
  respectRetryAfter: true,
  /** `delegate` keeps the shipped policy for non-transient failures; `bounded` retries them finitely. */
  configErrorBehavior: 'delegate',
  /** Write one warning line per scheduled retry. */
  logRetries: true,
})

/**
 * Assert a config value is a plain object.
 * @param value - candidate config.
 * @returns nothing; throws on a non-mapping value.
 */
function assertMapping(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('llm-retry-boost: config must be a mapping of option names to values')
  }
}

/**
 * Normalize and validate a raw plugin config.
 *
 * Omitted keys take {@link DEFAULT_SETTINGS}; unknown keys are rejected so a
 * typo in `cordis.patch.yml` fails loudly instead of silently keeping defaults.
 *
 * @param input - raw config from the loader entry.
 * @returns the resolved settings, including compiled lookup sets.
 */
export function resolveSettings(input) {
  const raw = input === undefined || input === null ? {} : input
  assertMapping(raw)

  for (const key of Object.keys(raw)) {
    if (!SETTINGS_KEYS.includes(key)) {
      throw new Error(
        `llm-retry-boost: unknown config key "${key}" (accepted keys: ${SETTINGS_KEYS.join(', ')})`,
      )
    }
  }

  const settings = { ...DEFAULT_SETTINGS }

  for (const key of ['enabled', 'respectRetryAfter', 'logRetries']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') {
      throw new Error(`llm-retry-boost: "${key}" must be a boolean`)
    }
    settings[key] = raw[key]
  }

  if (raw.retryableCodes !== undefined) {
    if (!Array.isArray(raw.retryableCodes)) {
      throw new Error('llm-retry-boost: "retryableCodes" must be an array of failure-code strings')
    }
    settings.retryableCodes = raw.retryableCodes.map((code) => {
      if (typeof code !== 'string' || code.trim() === '') {
        throw new Error('llm-retry-boost: every "retryableCodes" entry must be a non-empty string')
      }
      return code.trim().toUpperCase()
    })
  }

  if (raw.retryableHttpStatuses !== undefined) {
    if (!Array.isArray(raw.retryableHttpStatuses)) {
      throw new Error('llm-retry-boost: "retryableHttpStatuses" must be an array of HTTP status numbers')
    }
    settings.retryableHttpStatuses = raw.retryableHttpStatuses.map((status) => {
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error('llm-retry-boost: every "retryableHttpStatuses" entry must be an integer HTTP status')
      }
      return status
    })
  }

  if (raw.maxRetries !== undefined) {
    if (!Number.isInteger(raw.maxRetries) || raw.maxRetries < 0) {
      throw new Error('llm-retry-boost: "maxRetries" must be an integer >= 0 (0 means unlimited)')
    }
    settings.maxRetries = raw.maxRetries
  }

  if (raw.initialDelayMs !== undefined) {
    if (typeof raw.initialDelayMs !== 'number' || !Number.isFinite(raw.initialDelayMs)
      || raw.initialDelayMs < MIN_INITIAL_DELAY_MS) {
      throw new Error(`llm-retry-boost: "initialDelayMs" must be a finite number >= ${MIN_INITIAL_DELAY_MS}`)
    }
    settings.initialDelayMs = raw.initialDelayMs
  }

  if (raw.maxDelayMs !== undefined) {
    if (typeof raw.maxDelayMs !== 'number' || !Number.isFinite(raw.maxDelayMs) || raw.maxDelayMs <= 0) {
      throw new Error('llm-retry-boost: "maxDelayMs" must be a finite number > 0')
    }
    settings.maxDelayMs = raw.maxDelayMs
  }

  if (raw.jitterRatio !== undefined) {
    if (typeof raw.jitterRatio !== 'number' || !Number.isFinite(raw.jitterRatio)
      || raw.jitterRatio < 0 || raw.jitterRatio > 1) {
      throw new Error('llm-retry-boost: "jitterRatio" must be a finite number between 0 and 1')
    }
    settings.jitterRatio = raw.jitterRatio
  }

  if (raw.configErrorBehavior !== undefined) {
    if (!CONFIG_ERROR_BEHAVIORS.includes(raw.configErrorBehavior)) {
      throw new Error(
        `llm-retry-boost: "configErrorBehavior" must be one of ${CONFIG_ERROR_BEHAVIORS.join(', ')}`,
      )
    }
    settings.configErrorBehavior = raw.configErrorBehavior
  }

  return Object.freeze({
    ...settings,
    retryableCodes: Object.freeze([...settings.retryableCodes]),
    retryableHttpStatuses: Object.freeze([...settings.retryableHttpStatuses]),
    codeSet: new Set(settings.retryableCodes),
    statusSet: new Set(settings.retryableHttpStatuses),
  })
}

/**
 * Decide whether one provider failure is a retryable transient.
 *
 * Classification is an allow-list: anything the config does not name — a
 * credential, request, quota, protocol, or model error — is *not* transient and
 * therefore keeps the shipped policy.
 *
 * @param failure - the `LlmFailure` carried by `agent/request-error`.
 * @param settings - resolved settings.
 * @returns `true` when the failure stays retryable.
 */
export function isTransientFailure(failure, settings) {
  const code = typeof failure?.code === 'string' ? failure.code.toUpperCase() : ''
  if (code !== '' && settings.codeSet.has(code)) return true

  const match = /^HTTP_(\d{3})$/.exec(code)
  if (match !== null && settings.statusSet.has(Number(match[1]))) return true

  return typeof failure?.status === 'number' && settings.statusSet.has(failure.status)
}

/**
 * Read the finite budget a non-transient failure falls back to.
 *
 * Uses the exact provider policy when it is `normal`; otherwise the built-in
 * five-attempt budget, which is what the shipped policy ships when omitted.
 *
 * @param policy - the `ResolvedRetryPolicy` in the event payload.
 * @returns the number of attempts the default logic allows.
 */
export function defaultBudget(policy) {
  if (policy?.mode === 'normal' && Number.isFinite(policy.maxRetries) && policy.maxRetries >= 0) {
    return policy.maxRetries
  }
  return DEFAULT_NORMAL_BUDGET
}

/**
 * Read the shipped policy's own backoff, so a `bounded` fallback waits exactly
 * the way the default logic would.
 *
 * @param policy - the `ResolvedRetryPolicy` in the event payload.
 * @param respectRetryAfter - whether a provider `Retry-After` may override it.
 * @returns the backoff fields {@link computeDelay} reads.
 */
export function defaultBackoff(policy, respectRetryAfter) {
  if (policy?.mode === 'normal') {
    return {
      initialDelayMs: policy.initialDelayMs,
      maxDelayMs: policy.maxDelayMs,
      jitterRatio: policy.jitterRatio,
      respectRetryAfter,
    }
  }
  return { ...DEFAULT_NORMAL_BACKOFF, respectRetryAfter }
}

/**
 * Coerce a value to a finite number, or a fallback.
 * @param value - candidate.
 * @param fallback - value used when `value` is not finite.
 * @returns a finite number.
 */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Compute the wait before one retry attempt.
 *
 * A provider `Retry-After` wins when present and honoured, clamped to the
 * configured ceiling; otherwise the delay is `initialDelayMs * 2^(attempt-1)`
 * with symmetric jitter, capped at `maxDelayMs`. The result is always a finite
 * whole number of milliseconds: a malformed policy must never yield `NaN`,
 * which `setTimeout` would run immediately and turn into a hot retry loop.
 *
 * @param attempt - 1-based attempt number within the current retry chain.
 * @param failure - the failure that triggered this retry.
 * @param settings - resolved settings (or a `defaultBackoff()` result).
 * @param random - `[0, 1)` source for jitter.
 * @returns delay in milliseconds.
 */
export function computeDelay(attempt, failure, settings, random = Math.random) {
  const initialDelayMs = finiteOr(settings?.initialDelayMs, 1000)
  const maxDelayMs = Math.max(1, finiteOr(settings?.maxDelayMs, 60000))
  const jitterRatio = Math.min(1, Math.max(0, finiteOr(settings?.jitterRatio, 0)))

  const retryAfter = failure?.providerRetryAfterMs
  if (settings?.respectRetryAfter && typeof retryAfter === 'number'
    && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.round(Math.min(retryAfter, maxDelayMs))
  }

  const exponent = Math.min(Math.max(finiteOr(attempt, 1) - 1, 0), MAX_EXPONENT)
  const exponential = Math.min(initialDelayMs * 2 ** exponent, maxDelayMs)
  const factor = 1 - jitterRatio + 2 * jitterRatio * clamp01(random())
  return Math.round(Math.max(0, Math.min(exponential * factor, maxDelayMs)))
}

/**
 * Clamp a number into `[0, 1]`.
 * @param value - candidate jitter source value.
 * @returns the clamped value.
 */
function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

/**
 * Build the stable identity of this plugin's retry chain.
 *
 * Mirrors the shipped policy key: every behaviour-affecting field participates,
 * so changing the settings starts a fresh chain instead of inheriting an old
 * attempt count. `llm/retry` events carry this key, which is also how the
 * plugin's chain stays distinguishable from the shipped policy's chain.
 *
 * @param settings - resolved settings.
 * @returns a JSON string stable across restarts.
 */
export function policyKeyOf(settings) {
  return JSON.stringify([
    'llm-retry-boost',
    1,
    settings.maxRetries,
    [...settings.codeSet].sort(),
    [...settings.statusSet].sort((a, b) => a - b),
    settings.initialDelayMs,
    settings.maxDelayMs,
    settings.jitterRatio,
    settings.respectRetryAfter,
    settings.configErrorBehavior,
  ])
}
