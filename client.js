/**
 * Browser half of `dsh-llm-retry-boost`.
 *
 * The Plugins page renders one configuration page per row that registers into
 * `plugins.row.config`. This module registers the page for the plugin's own row
 * (`dsh-llm-retry-boost#llm-retry-boost`), so opening Plugins → LLM infinite
 * retry (capped backoff) shows the retry budget, the wait curve, and the
 * non-transient fallback as editable fields.
 *
 * Everything here is presentation: the page owner supplies the live form
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
      intro: '这些值保存在当前 profile 的配置里，保存后立即生效，不需要重启。',
      budget: '重试预算',
      budgetHint: '临时故障（过载、限流、超时、传输、空响应）最多重试几次。0 表示一直重试到服务恢复。',
      wait: '等待曲线',
      waitHint: '首次失败后等多久重试，之后每次都翻倍，但不超过等待上限。',
      initialDelayMs: '首次等待（毫秒）',
      initialDelayMsHint: '默认 1000，也就是 1 秒。',
      maxDelayMs: '等待上限（毫秒）',
      maxDelayMsHint: '默认 60000，也就是 1 分钟；到达后每次重试都按这个上限等待。',
      jitterRatio: '抖动比例（0–1）',
      jitterRatioHint: '在等待时间上加入随机浮动，避免多个请求同时重试；0 表示不抖动。',
      other: '其他行为',
      respectRetryAfter: '遵守服务端的 Retry-After',
      respectRetryAfterHint: '服务端明确要求等待多久时，按它给的时间等，但仍然不超过等待上限。',
      logRetries: '每次重试写一条日志',
      configErrorBehavior: '配置类错误的处理方式',
      configErrorBehaviorHint: '密钥错误、模型名错误、请求非法、额度耗尽这类错误不属于临时故障。',
      behaviorDelegate: '交给内置策略（默认：直接报错）',
      behaviorBounded: '按内置的有限预算重试（5 次）',
      enabled: '启用这个插件',
      enabledHint: '关闭后完全回到内置的重试执行器。',
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
      intro: 'These values live in the active profile’s configuration and apply immediately after saving — no restart.',
      budget: 'Retry budget',
      budgetHint: 'How many times a transient failure (overload, rate limit, timeout, transport, empty response) may be retried. 0 keeps retrying until the provider recovers.',
      wait: 'Wait curve',
      waitHint: 'How long to wait after the first failure; each later attempt doubles that wait, up to the ceiling.',
      initialDelayMs: 'First wait (ms)',
      initialDelayMsHint: 'Defaults to 1000 — one second.',
      maxDelayMs: 'Wait ceiling (ms)',
      maxDelayMsHint: 'Defaults to 60000 — one minute. Once reached, every retry waits this long.',
      jitterRatio: 'Jitter ratio (0–1)',
      jitterRatioHint: 'Adds randomness to each wait so retries do not synchronize; 0 disables it.',
      other: 'Other behaviour',
      respectRetryAfter: 'Honour the server’s Retry-After',
      respectRetryAfterHint: 'When the provider asks for a specific wait, use it — still clamped to the ceiling.',
      logRetries: 'Log one line per retry',
      configErrorBehavior: 'Configuration-class failures',
      configErrorBehaviorHint: 'A bad key, an unknown model, a rejected request, or an exhausted quota is not transient.',
      behaviorDelegate: 'Hand back to the shipped policy (default: fail fast)',
      behaviorBounded: 'Retry the shipped finite budget (5 attempts)',
      enabled: 'Enable this plugin',
      enabledHint: 'Off restores the shipped retry executor untouched.',
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
     * `type` drives parsing and the control; `fallback` mirrors the Host
     * plugin’s own default so an unset field still displays a sane value.
     */
    const FIELDS = [
      { key: 'maxRetries', type: 'integer', min: 0, fallback: 0, section: 'budget' },
      { key: 'initialDelayMs', type: 'number', min: 100, fallback: 1000, section: 'wait' },
      { key: 'maxDelayMs', type: 'number', min: 1, fallback: 60000, section: 'wait' },
      { key: 'jitterRatio', type: 'number', min: 0, max: 1, fallback: 0.1, section: 'wait' },
      { key: 'respectRetryAfter', type: 'boolean', fallback: true, section: 'other' },
      { key: 'configErrorBehavior', type: 'enum', values: ['delegate', 'bounded'], fallback: 'delegate', section: 'other' },
      { key: 'logRetries', type: 'boolean', fallback: true, section: 'other' },
      { key: 'enabled', type: 'boolean', fallback: true, section: 'other' },
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
      if (field.type === 'enum') return String(value)
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

    /** The page’s one-line summary, shown when the row has no description. */
    function summary(t) {
      return t('summary')
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

      if (view === 'summary') return summary(t)
      if (form === undefined) return h('p', { style: MUTED }, t('unavailable'))
      if (state.status === 'loading') return h('p', { style: MUTED }, t('loading'))
      if (state.status === 'unavailable') return h('p', { style: MUTED }, t('unavailable'))

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
        if (accepted) {
          setPhase('saved')
        } else {
          setPhase('failed')
        }
      }

      const fieldNode = (field) => {
        const overridden = state.user !== undefined && state.user !== null
          && Object.prototype.hasOwnProperty.call(state.user, field.key)
        const isReset = resets.has(field.key)
        const children = []
        if (field.type === 'boolean') {
          children.push(h('input', {
            key: 'control',
            id: `dsh-lrb-${field.key}`,
            type: 'checkbox',
            checked: draft[field.key] === true,
            disabled: !writable || busy,
            onChange: (event) => edit(field.key, event.target.checked),
            style: { width: 16, height: 16, accentColor: 'var(--dsw-alias-brand-primary)' },
          }))
        } else if (field.type === 'enum') {
          children.push(h('select', {
            key: 'control',
            id: `dsh-lrb-${field.key}`,
            value: draft[field.key],
            disabled: !writable || busy,
            onChange: (event) => edit(field.key, event.target.value),
            style: {
              font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '6px 10px',
              minWidth: 260,
            },
          }, field.values.map((value) => h('option', { key: value, value },
            value === 'delegate' ? t('behaviorDelegate') : t('behaviorBounded')))))
        } else {
          children.push(h('input', {
            key: 'control',
            id: `dsh-lrb-${field.key}`,
            type: 'number',
            inputMode: field.type === 'integer' ? 'numeric' : 'decimal',
            min: field.min,
            max: field.max,
            step: field.type === 'integer' ? 1 : 'any',
            value: draft[field.key],
            disabled: !writable || busy,
            'aria-invalid': errors[field.key] !== undefined,
            onChange: (event) => edit(field.key, event.target.value),
            style: {
              font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-layer-2)',
              border: `1px solid ${errors[field.key] === undefined ? 'var(--dsw-alias-border-l1)' : 'var(--dsw-alias-state-error-primary)'}`,
              borderRadius: 8, padding: '6px 10px', width: 140,
            },
          }))
        }

        const meta = []
        if (errors[field.key] !== undefined) {
          meta.push(h('span', { key: 'error', style: { color: 'var(--dsw-alias-state-error-primary)' } }, errorText(field)))
        } else if (isReset) {
          meta.push(h('span', { key: 'reset', style: MUTED }, t('defaultTag')))
        } else if (overridden) {
          meta.push(h('span', { key: 'tag', style: TAG }, t('overridden')))
          meta.push(h('button', {
            key: 'reset',
            type: 'button',
            onClick: () => reset(field.key),
            disabled: busy,
            style: LINK_BUTTON,
          }, t('reset')))
        }

        return h('div', { key: field.key, style: FIELD },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('label', { htmlFor: `dsh-lrb-${field.key}`, style: { fontWeight: 500 } }, t(field.key)),
            ...children,
            ...meta,
          ),
          h('p', { style: HINT }, t(`${field.key}Hint`)),
        )
      }

      const groups = SECTIONS.map((section) => h('section', { key: section, style: { display: 'grid', gap: 14 } },
        section === 'budget'
          ? h('h4', { style: SECTION_TITLE }, t('budget'))
          : h('h4', { style: SECTION_TITLE }, t(section === 'wait' ? 'wait' : 'other')),
        section === 'budget' ? h('p', { style: HINT }, t('budgetHint')) : null,
        section === 'wait' ? h('p', { style: HINT }, t('waitHint')) : null,
        ...FIELDS.filter((field) => field.section === section).map(fieldNode),
      ))

      const status = phase === 'saved'
        ? h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, t('saved'))
        : phase === 'failed'
          ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('saveFailed'))
          : null

      return h('div', { style: { display: 'grid', gap: 18 }, 'data-plugin-config': 'llm-retry-boost' },
        h('p', { style: MUTED }, t('intro')),
        writable ? null : h('p', { style: MUTED }, t('readOnly')),
        ...groups,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 4 } },
          h('button', {
            type: 'button',
            onClick: save,
            disabled: !writable || busy || invalid || !dirty,
            style: {
              font: 'inherit', fontWeight: 500, padding: '7px 16px', borderRadius: 8, cursor: 'pointer',
              color: '#fff', border: '1px solid transparent',
              background: 'var(--dsw-alias-brand-primary)',
              opacity: !writable || busy || invalid || !dirty ? 0.5 : 1,
            },
          }, busy ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            onClick: () => {
              setDraft(draftFrom(state))
              setResets(new Set())
              setPhase('idle')
            },
            disabled: busy || !dirty,
            style: { ...LINK_BUTTON, opacity: busy || !dirty ? 0.5 : 1 },
          }, t('discard')),
          status,
        ),
      )
    }

    /** Button-style inline link. */
    const LINK_BUTTON = {
      font: 'inherit', fontSize: 13, color: 'var(--dsw-alias-label-secondary)',
      background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline',
    }

    const MUTED = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: 0 }
    const HINT = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, margin: '4px 0 0' }
    const FIELD = { display: 'grid', gap: 2 }
    const TAG = {
      fontSize: 11, padding: '1px 6px', borderRadius: 999,
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
      border: '1px solid var(--dsw-alias-border-l1)',
    }
    const SECTION_TITLE = { margin: '4px 0 0', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }

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
      __test: { FIELDS, buildOps, draftFrom, parseField, valueOf, form: RetryBoostForm },
    }
  },
})
