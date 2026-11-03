/**
 * Loader-visible configuration for `dsh-llm-retry-boost`.
 *
 * The schema is what turns the retry budget into a form on the Plugins page.
 * The Settings service projects only fields declared `.volatile()` — the ones
 * an operator may safely change while the session keeps running — and the Host
 * reuses the same reference after a form write, so `apply` reads those values at
 * decision time instead of snapshotting them once at mount.
 *
 * The two allow-lists and the `enabled` escape hatch stay ordinary
 * configuration on purpose: the allow-lists are a developer seam whose change
 * alters which failures this plugin owns, and whether a row runs at all is the
 * Plugins page's row switch — switching the row off unloads it, and the shipped
 * retry executor applies unchanged.
 *
 * @module dsh-llm-retry-boost/config
 */

import z from '@deepseek-ai/schemastery'

import { DEFAULT_RETRYABLE_CODES, DEFAULT_RETRYABLE_HTTP_STATUSES } from './policy.js'

/**
 * Mark a field editable without remounting.
 *
 * `.volatile()` is the Host's own spelling. A plugin installed into a profile
 * that carries an older `@deepseek-ai/schemastery` still builds the same schema
 * — the marker lives in the field metadata either way — so an edition mismatch
 * degrades live reference updates instead of failing the whole row.
 *
 * @param schema - the field schema.
 * @returns the same schema, marked volatile.
 */
function editable(schema) {
  if (schema?.meta?.volatile === true) return schema
  if (typeof schema.volatile === 'function') return schema.volatile()
  if (typeof schema.extra === 'function') return schema.extra('volatile', true)
  return schema
}

/**
 * The row schema.
 *
 * Defaults mirror `DEFAULT_SETTINGS` in `policy.js`; `policy.js` remains the
 * authority at runtime because it also serves callers that bypass the loader.
 */
export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('YAML escape hatch only; the Plugins page row switch is the user-facing control.'),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES])
    .description('Failure codes retried under this plugin’s own budget.'),
  retryableHttpStatuses: z.array(z.number().step(1)).default([...DEFAULT_RETRYABLE_HTTP_STATUSES])
    .description('HTTP statuses whose HTTP_<status> failure code stays retryable.'),
  maxRetries: editable(z.number().step(1).min(0).default(0))
    .description('Attempt budget for transient failures; 0 retries until the provider recovers.'),
  initialDelayMs: editable(z.number().min(100).default(1000))
    .description('First backoff delay in milliseconds; doubled per attempt.'),
  maxDelayMs: editable(z.number().min(1).default(60000))
    .description('Ceiling in milliseconds for every computed delay.'),
  jitterRatio: editable(z.number().min(0).max(1).default(0.1))
    .description('Symmetric jitter ratio applied to the local backoff; 0 disables it.'),
  respectRetryAfter: editable(z.boolean().default(true))
    .description('Honour a provider Retry-After header, clamped to the delay ceiling.'),
  configErrorBehavior: editable(z.union([z.const('delegate'), z.const('bounded')]).default('delegate'))
    .description('What a configuration-class failure does: keep the shipped policy, or retry it finitely.'),
  logRetries: editable(z.boolean().default(true))
    .description('Write one warning line per scheduled retry.'),
})
