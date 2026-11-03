/**
 * Browser half of `dsh-llm-retry-boost`.
 *
 * The Plugins page renders one configuration page per row that registers into
 * `plugins.row.config`. This module registers the page for the plugin's own row
 * (`dsh-llm-retry-boost#llm-retry-boost`), so opening Plugins → LLM infinite
 * retry (capped backoff) shows the retry budget, the wait curve, and the
 * non-transient fallback as editable fields.
 *
 * Whether the plugin runs at all is not a field here: the Plugins page's row
 * switch owns that. Switching the row off unloads this plugin, and the shipped
 * retry executor applies unchanged — that is the default when it is off.
 *
 * Everything below is presentation: the page owner supplies the live form
 * snapshot (`state`) and its write queue (`mutate`), which the Host backs with
 * the Settings service and persists into the active profile's Cordis patch.
 * The Host plugin reads its volatile config references at decision time, so a
 * save takes effect without reloading anything.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-retry-boost',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this client half. */
    const NS = 'llm-retry-boost'
    /** Registration key: `<bundle package>#<row id>` as the bundle patch declares them. */
    const ROW_KEY = 'dsh-llm-retry-boost#llm-retry-boost'

    /** Simplified Chinese copy; the key source of truth. */
    const zh = {
      title: '无限重试（封顶退避）',
      summary: '临时故障无限重试，等待按指数增长并封顶。',
      intro: '这些值保存在当前 profile 的配置里，保存后立即生效，不需要重启；插件本身的开关在插件页的这一行上。',
      budget: '重试预算',
      budgetHint: '临时故障（过载、限流、超时、传输、空响应）最多重试几次。',
      wait: '等待曲线',
      waitHint: '第一次失败后等多久再试，之后每次都翻倍，但不超过等待上限。',
      other: '其他行为',
      maxRetries: '最大重试次数',
      maxRetriesHint: '0 表示不限次数，一直重试到服务恢复；填正数则用完就结束本轮。',
      initialDelayMs: '首次等待',
      initialDelayMsHint: '默认 1000 毫秒，也就是 1 秒。',
      maxDelayMs: '等待上限',
      maxDelayMsHint: '默认 60000 毫秒（1 分钟）；到达后每次重试都按这个上限等待。',
      jitterRatio: '抖动比例',
      jitterRatioHint: '在等待时间上加入随机浮动，避免多个请求同时重试；0 表示不抖动。',
      respectRetryAfter: '遵守服务端的 Retry-After',
      respectRetryAfterHint: '服务端明确要求等待多久时，按它给的时间等，但仍然不超过等待上限。',
      configErrorBehavior: '配置类错误的处理方式',
      configErrorBehaviorHint: '密钥错误、模型名错误、请求非法、额度耗尽这类错误不属于临时故障。',
      behaviorDelegate: '交给内置策略（默认：直接报错）',
      behaviorBounded: '按内置的有限预算重试（5 次）',
      logRetries: '每次重试写一条日志',
      logRetriesHint: '在宿主日志里为每次调度打印一行，方便排查。',
      unitMs: '毫秒',
      unitTimes: '次',
      preview: '当前：{attempts}，首次等待 {start}，之后翻倍，封顶 {cap}，抖动 ±{jitter}%',
      previewInvalid: '当前填写的值还不完整，补齐后这里会显示实际生效的曲线。',
      attemptsUnlimited: '不限次数',
      attemptsLimited: '最多 {n} 次',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      discard: '放弃修改',
      reset: '恢复默认',
      overridden: '已覆盖',
      defaultTag: '默认',
      invalidNumber: '请填一个不小于 {min} 的数字。',
      invalidInteger: '请填一个不小于 {min} 的整数。',
      invalidRange: '请填 0 到 1 之间的数字。',
      saveFailed: '部署没有接受这次修改，值已保留供你修改。',
      loading: '正在读取当前配置…',
      unavailable: '当前部署没有为这个插件提供可编辑的配置。',
      readOnly: '当前部署的配置是只读的。',
    }

    /** English copy. */
    const en = {
      title: 'Infinite retry (capped backoff)',
      summary: 'Retry transient failures forever under capped exponential backoff.',
      intro: 'These values live in the active profile’s configuration and apply immediately after saving — no restart. The plugin’s on/off switch is the row switch on the Plugins page.',
      budget: 'Retry budget',
      budgetHint: 'How many times a transient failure (overload, rate limit, timeout, transport, empty response) may be retried.',
      wait: 'Wait curve',
      waitHint: 'How long to wait after the first failure; each later attempt doubles that wait, up to the ceiling.',
      other: 'Other behaviour',
      maxRetries: 'Max retries',
      maxRetriesHint: '0 means no limit — keep retrying until the provider recovers. A positive number ends the turn after that many attempts.',
      initialDelayMs: 'First wait',
      initialDelayMsHint: 'Defaults to 1000 ms — one second.',
      maxDelayMs: 'Wait ceiling',
      maxDelayMsHint: 'Defaults to 60000 ms (one minute). Once reached, every retry waits this long.',
      jitterRatio: 'Jitter ratio',
      jitterRatioHint: 'Adds randomness to each wait so retries do not synchronize; 0 disables it.',
      respectRetryAfter: 'Honour the server’s Retry-After',
      respectRetryAfterHint: 'When the provider asks for a specific wait, use it — still clamped to the ceiling.',
      configErrorBehavior: 'Configuration-class failures',
      configErrorBehaviorHint: 'A bad key, an unknown model, a rejected request, or an exhausted quota is not transient.',
      behaviorDelegate: 'Hand back to the shipped policy (default: fail fast)',
      behaviorBounded: 'Retry the shipped finite budget (5 attempts)',
      logRetries: 'Log one line per retry',
      logRetriesHint: 'Prints one host-log line per scheduled attempt, for diagnosis.',
      unitMs: 'ms',
      unitTimes: 'times',
      preview: 'Current: {attempts}, first wait {start}, doubling, capped at {cap}, jitter ±{jitter}%',
      previewInvalid: 'These values are incomplete; the effective curve appears once they are filled in.',
      attemptsUnlimited: 'unlimited',
      attemptsLimited: 'at most {n} times',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      discard: 'Discard changes',
      reset: 'Reset to default',
      overridden: 'Overridden',
      defaultTag: 'Default',
      invalidNumber: 'Enter a number of at least {min}.',
      invalidInteger: 'Enter a whole number of at least {min}.',
      invalidRange: 'Enter a number between 0 and 1.',
      saveFailed: 'The deployment did not accept these values; they were kept for you to correct.',
      loading: 'Reading the current configuration…',
      unavailable: 'This deployment exposes no editable configuration for this plugin.',
      readOnly: 'This deployment stores configuration read-only.',
    }

    /**
     * One editable field.
     *
     * `type` drives parsing and the control; `unit` is the suffix the control
     * shows; `fallback` mirrors the Host plugin’s own default so an unset field
     * still displays a sane value.
     */
    const FIELDS = [
      { key: 'maxRetries', type: 'integer', min: 0, fallback: 0, unit: 'times', section: 'budget' },
      { key: 'initialDelayMs', type: 'number', min: 100, fallback: 1000, unit: 'ms', section: 'wait' },
      { key: 'maxDelayMs', type: 'number', min: 1, fallback: 60000, unit: 'ms', section: 'wait' },
      { key: 'jitterRatio', type: 'number', min: 0, max: 1, fallback: 0.1, section: 'wait' },
      { key: 'respectRetryAfter', type: 'boolean', fallback: true, section: 'other' },
      { key: 'configErrorBehavior', type: 'enum', values: ['delegate', 'bounded'], fallback: 'delegate', section: 'other' },
      { key: 'logRetries', type: 'boolean', fallback: true, section: 'other' },
    ]

    const SECTIONS = ['budget', 'wait', 'other']

    /** Read a config value that may be missing from the projected form. */
    function valueOf(source, field) {
      const value = source?.[field.key]
      return value === undefined || value === null ? field.fallback : value
    }

    /** Render one value into its draft representation. */
    function draftOf(field, value) {
      if (field.type === 'boolean') return value === true
      return String(value)
    }

    /** Parse one draft value, or `undefined` when it is not acceptable. */
    function parseField(field, draft) {
      if (field.type === 'boolean') return draft === true
      if (field.type === 'enum') return field.values.includes(draft) ? draft : undefined
      const text = String(draft).trim()
      if (text === '') return undefined
      if (field.type === 'integer' && !/^-?\d+$/.test(text)) return undefined
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) return undefined
      if (field.min !== undefined && parsed < field.min) return undefined
      if (field.max !== undefined && parsed > field.max) return undefined
      return field.type === 'integer' ? Math.trunc(parsed) : parsed
    }

    /** Build the initial draft from a form snapshot. */
    function draftFrom(state) {
      const draft = {}
      for (const field of FIELDS) draft[field.key] = draftOf(field, valueOf(state?.value, field))
      return draft
    }

    /**
     * Turn the draft into one revisioned mutation.
     *
     * Pure on purpose: the page’s whole write contract is decided here, so the
     * unit test exercises it without a DOM. `errors` maps a field to the copy
     * key the form shows for it.
     *
     * @param state - the live form snapshot.
     * @param draft - the staged values.
     * @param resets - fields the operator staged back to their inherited value.
     * @returns the ordered operations and the per-field validation errors.
     */
    function buildOps(state, draft, resets) {
      const ops = []
      const errors = {}
      for (const field of FIELDS) {
        if (resets.has(field.key)) {
          ops.push({ op: 'unset', path: [field.key] })
          continue
        }
        const parsed = parseField(field, draft[field.key])
        if (parsed === undefined) {
          errors[field.key] = field.type === 'integer'
            ? 'invalidInteger'
            : field.type === 'number' && field.max !== undefined && field.min === 0 ? 'invalidRange' : 'invalidNumber'
          continue
        }
        if (parsed !== valueOf(state.value, field)) ops.push({ op: 'set', path: [field.key], value: parsed })
      }
      return { ops, errors }
    }

    /**
     * Format a duration for the preview line.
     * @param ms - milliseconds.
     * @returns a compact technical duration such as `1s`, `1.5s`, or `800ms`.
     */
    function duration(ms) {
      if (ms >= 1000) {
        const seconds = ms / 1000
        return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`
      }
      return `${Math.round(ms)}ms`
    }

    /**
     * Describe the curve the current draft would produce.
     * @param draft - staged values.
     * @param t - the page dictionary reader.
     * @returns the preview line, or the incomplete-values notice.
     */
    function previewOf(draft, t) {
      const parse = (key) => {
        const field = FIELDS.find((candidate) => candidate.key === key)
        return parseField(field, draft[key])
      }
      const maxRetries = parse('maxRetries')
      const initialDelayMs = parse('initialDelayMs')
      const maxDelayMs = parse('maxDelayMs')
      const jitterRatio = parse('jitterRatio')
      if ([maxRetries, initialDelayMs, maxDelayMs, jitterRatio].some((value) => value === undefined)) {
        return t('previewInvalid')
      }

      const attempts = maxRetries === 0 ? t('attemptsUnlimited') : t('attemptsLimited', { n: maxRetries })
      return t('preview', {
        attempts,
        start: duration(initialDelayMs),
        cap: duration(maxDelayMs),
        jitter: String(Math.round(jitterRatio * 100)),
      })
    }

    /** Component-scoped stylesheet: theme tokens only, no hard-coded colors. */
    const STYLES = `
      .dsh-lrb { display: grid; gap: 20px; color: var(--dsw-alias-label-primary); }
      .dsh-lrb-intro { margin: 0; max-width: 72ch; font-size: 13px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
      .dsh-lrb-preview { margin: 0; padding: 10px 14px; border-radius: 10px; font-size: 12.5px; line-height: 1.55;
        color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1); font-variant-numeric: tabular-nums; }
      .dsh-lrb-section { display: grid; gap: 10px; padding-top: 20px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .dsh-lrb-section:first-of-type { padding-top: 0; border-top: none; }
      .dsh-lrb-h { margin: 0; font-size: 13.5px; font-weight: 600; }
      .dsh-lrb-sub { margin: -4px 0 0; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
      .dsh-lrb-rows { display: grid; gap: 2px; }
      .dsh-lrb-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; align-items: center;
        padding: 10px 12px; margin: 0 -12px; border-radius: 10px; }
      .dsh-lrb-row:hover { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 65%, transparent); }
      .dsh-lrb-name { font-size: 13px; font-weight: 500; }
      .dsh-lrb-hint { margin: 3px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dsh-lrb-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
      .dsh-lrb-field { width: 116px; box-sizing: border-box; padding: 7px 10px; font: inherit; font-size: 13px;
        font-variant-numeric: tabular-nums; text-align: right; color: inherit;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
      .dsh-lrb-field:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .dsh-lrb-field[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
      .dsh-lrb-field:disabled { opacity: 0.55; }
      .dsh-lrb-select { max-width: 330px; padding: 7px 10px; font: inherit; font-size: 13px; color: inherit;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
      .dsh-lrb-switch { width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
      .dsh-lrb-unit { min-width: 22px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dsh-lrb-tag { padding: 1px 7px; font-size: 11px; line-height: 1.6; border-radius: 999px;
        color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1); }
      .dsh-lrb-reset, .dsh-lrb-discard { padding: 0; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary);
        background: none; border: none; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
      .dsh-lrb-reset:hover, .dsh-lrb-discard:hover { color: var(--dsw-alias-label-primary); }
      .dsh-lrb-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
      .dsh-lrb-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
        padding-top: 18px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .dsh-lrb-save { padding: 8px 20px; font: inherit; font-size: 13px; font-weight: 500; border-radius: 8px;
        color: #fff; background: var(--dsw-alias-brand-primary); border: 1px solid transparent; cursor: pointer; }
      .dsh-lrb-save:hover:not(:disabled) { filter: brightness(1.08); }
      .dsh-lrb-save:disabled { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
        border-color: var(--dsw-alias-border-l1); cursor: default; }
      .dsh-lrb-discard:disabled { opacity: 0.45; cursor: default; text-decoration: none; }
      .dsh-lrb-status { font-size: 12px; }
      @media (max-width: 640px) {
        .dsh-lrb-row { grid-template-columns: 1fr; gap: 10px; }
        .dsh-lrb-control { justify-content: flex-start; }
      }
    `

    /**
     * The row’s configuration page.
     *
     * @param props - `view`, the page dictionary reader `t`, and the live `form`.
     * @returns the summary line, or the editable form.
     */
    function RetryBoostForm(props) {
      const { t, view, form } = props
      const state = form?.state
      const [draft, setDraft] = React.useState(() => draftFrom(state))
      const [resets, setResets] = React.useState(() => new Set())
      const [phase, setPhase] = React.useState('idle')

      // A new Host revision (a save, or an edit from another window) replaces
      // the draft: the form never shows values the Host no longer reports.
      const revision = state?.revision
      React.useEffect(() => {
        setDraft(draftFrom(state))
        setResets(new Set())
        setPhase('idle')
      }, [revision])

      if (view === 'summary') return t('summary')
      if (form === undefined) return h('p', { className: 'dsh-lrb-intro' }, t('unavailable'))
      if (state.status === 'loading') return h('p', { className: 'dsh-lrb-intro' }, t('loading'))
      if (state.status === 'unavailable') return h('p', { className: 'dsh-lrb-intro' }, t('unavailable'))

      const writable = state.writable === true && state.status === 'ready'
      const { ops, errors } = buildOps(state, draft, resets)
      const invalid = Object.keys(errors).length > 0
      const dirty = ops.length > 0
      const busy = phase === 'saving'

      /** Render one validation key with the field’s own bound. */
      const errorText = (field) => {
        const key = errors[field.key]
        return key === 'invalidRange' ? t(key) : t(key, { min: field.min ?? 0 })
      }

      /** Stage one draft edit and drop the field from the reset set. */
      const edit = (key, value) => {
        setDraft((previous) => ({ ...previous, [key]: value }))
        setResets((previous) => {
          if (!previous.has(key)) return previous
          const next = new Set(previous)
          next.delete(key)
          return next
        })
        setPhase('idle')
      }

      /** Stage one field back to the value beneath the profile override. */
      const reset = (key) => {
        const field = FIELDS.find((candidate) => candidate.key === key)
        setDraft((previous) => ({ ...previous, [key]: draftOf(field, valueOf(state.base, field)) }))
        setResets((previous) => new Set(previous).add(key))
        setPhase('idle')
      }

      /** Write every staged change in one revisioned mutation. */
      const save = async () => {
        if (invalid || !dirty || !writable) return
        setPhase('saving')
        let accepted = false
        try {
          accepted = await form.mutate(ops, state.revision)
        } catch {
          accepted = false
        }
        setPhase(accepted ? 'saved' : 'failed')
      }

      /** One label, hint, control, and its per-field annotations. */
      const fieldRow = (field) => {
        const overridden = state.user !== undefined && state.user !== null
          && Object.prototype.hasOwnProperty.call(state.user, field.key)
        const isReset = resets.has(field.key)
        const disabled = !writable || busy
        const control = []

        if (field.type === 'boolean') {
          control.push(h('input', {
            key: 'control',
            id: `dsh-lrb-${field.key}`,
            type: 'checkbox',
            className: 'dsh-lrb-switch',
            checked: draft[field.key] === true,
            disabled,
            onChange: (event) => edit(field.key, event.target.checked),
          }))
        } else if (field.type === 'enum') {
          control.push(h('select', {
            key: 'control',
            id: `dsh-lrb-${field.key}`,
            className: 'dsh-lrb-select',
            value: draft[field.key],
            disabled,
            onChange: (event) => edit(field.key, event.target.value),
          }, field.values.map((value) => h('option', { key: value, value },
            value === 'delegate' ? t('behaviorDelegate') : t('behaviorBounded')))))
        } else {
          control.push(h('input', {
            key: 'control',
            id: `dsh-lrb-${field.key}`,
            className: 'dsh-lrb-field',
            type: 'number',
            inputMode: field.type === 'integer' ? 'numeric' : 'decimal',
            min: field.min,
            max: field.max,
            step: field.type === 'integer' ? 1 : 'any',
            value: draft[field.key],
            disabled,
            'aria-invalid': errors[field.key] !== undefined,
            onChange: (event) => edit(field.key, event.target.value),
          }))
          if (field.unit !== undefined) {
            control.push(h('span', { key: 'unit', className: 'dsh-lrb-unit' }, t(field.unit === 'ms' ? 'unitMs' : 'unitTimes')))
          }
        }

        if (errors[field.key] !== undefined) {
          control.push(h('span', { key: 'error', className: 'dsh-lrb-error' }, errorText(field)))
        } else if (isReset) {
          control.push(h('span', { key: 'default', className: 'dsh-lrb-tag' }, t('defaultTag')))
        } else if (overridden) {
          control.push(h('span', { key: 'tag', className: 'dsh-lrb-tag' }, t('overridden')))
          control.push(h('button', {
            key: 'reset',
            type: 'button',
            className: 'dsh-lrb-reset',
            disabled,
            onClick: () => reset(field.key),
          }, t('reset')))
        }

        return h('div', { key: field.key, className: 'dsh-lrb-row' },
          h('div', {},
            h('label', { htmlFor: `dsh-lrb-${field.key}`, className: 'dsh-lrb-name' }, t(field.key)),
            h('p', { className: 'dsh-lrb-hint' }, t(`${field.key}Hint`)),
          ),
          h('div', { className: 'dsh-lrb-control' }, ...control),
        )
      }

      const sections = SECTIONS.map((section) => h('section', { key: section, className: 'dsh-lrb-section' },
        h('h4', { className: 'dsh-lrb-h' }, t(section)),
        section === 'other' ? null : h('p', { className: 'dsh-lrb-sub' }, t(`${section}Hint`)),
        h('div', { className: 'dsh-lrb-rows' },
          ...FIELDS.filter((field) => field.section === section).map(fieldRow)),
      ))

      const status = phase === 'saved'
        ? h('span', { className: 'dsh-lrb-status', style: { color: 'var(--dsw-alias-state-success-primary)' } }, t('saved'))
        : phase === 'failed'
          ? h('span', { className: 'dsh-lrb-status', style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('saveFailed'))
          : null

      return h('div', { className: 'dsh-lrb', 'data-plugin-config': 'llm-retry-boost' },
        h('style', { key: 'styles' }, STYLES),
        h('p', { className: 'dsh-lrb-intro' }, t('intro')),
        h('p', { className: 'dsh-lrb-preview' }, previewOf(draft, t)),
        writable ? null : h('p', { className: 'dsh-lrb-intro' }, t('readOnly')),
        ...sections,
        h('div', { className: 'dsh-lrb-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-lrb-save',
            disabled: !writable || busy || invalid || !dirty,
            onClick: save,
          }, busy ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            className: 'dsh-lrb-discard',
            disabled: busy || !dirty,
            onClick: () => {
              setDraft(draftFrom(state))
              setResets(new Set())
              setPhase('idle')
            },
          }, t('discard')),
          status,
        ),
      )
    }

    /**
     * Mount the row configuration page.
     *
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-retry-boost: dictionaries')
      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
        locale: NS,
        label: () => t('title'),
      }, RetryBoostForm)), 'llm-retry-boost: row configuration page')
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      /**
       * Test seam: the form’s pure decisions, so the unit test can exercise the
       * write contract without a DOM. Production code never reads it.
       */
      __test: {
        FIELDS,
        SECTIONS,
        buildOps,
        draftFrom,
        parseField,
        valueOf,
        previewOf,
        form: RetryBoostForm,
        dictionaries: { zh, en },
      },
    }
  },
})
