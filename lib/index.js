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
 * Layout
 * ------
 * `engine.js` holds the wiring and has no Host-only imports, so its tests run
 * in a plain Node process; `config.js` holds the loader schema that makes the
 * tunable fields appear on the Plugins page; `policy.js` holds the pure
 * decision helpers. This module is the package entry the loader imports.
 *
 * @module dsh-llm-retry-boost
 */

export { apply, name } from './engine.js'
export { Config } from './config.js'
