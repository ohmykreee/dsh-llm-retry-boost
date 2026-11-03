/**
 * Tests for the browser half of `dsh-llm-retry-boost`.
 *
 * The module is a `window.__ModuleLoader__` factory, so the test installs a
 * loader stub, feeds the factory a minimal React stub, and drives the returned
 * component as a plain function. That exercises the real registration and the
 * real write contract (which operations one save produces) without a browser,
 * a DOM, or a React installation.
 *
 * Run with `node test/client.test.mjs`.
 */

import assert from 'node:assert/strict'

/** Ordered list of `[name, fn]` cases. */
const cases = []
function test(name, fn) {
  cases.push([name, fn])
}

/**
 * Minimal React stand-in: enough for `createElement`, one-shot hooks, and a
 * component invocation that returns a walkable element tree.
 */
const ReactStub = {
  createElement(type, props, ...children) {
    const element = { type, props: { ...(props ?? {}) } }
    if (children.length === 1) element.props.children = children[0]
    else if (children.length > 1) element.props.children = children
    return element
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {
    /* effects never run in this stub */
  },
}

/** Captured loader entry from the module script. */
const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry)
    },
  },
}

await import(new URL('../client.js', import.meta.url).href)

/**
 * Load the module factory once and return the plugin namespace.
 * @returns the module the loader would adopt.
 */
function loadModule() {
  assert.equal(loaded.length, 1, 'the module registers exactly one loader entry')
  const [entry] = loaded
  assert.equal(entry.id, 'dsh-llm-retry-boost')
  return entry.factory((specifier) => {
    assert.equal(specifier, 'react', 'the browser half requires nothing but React')
    return ReactStub
  })
}

/**
 * Collect every element matching a predicate.
 * @param node - element, array, or primitive.
 * @param predicate - receives each element.
 * @param out - accumulator.
 * @returns the matches.
 */
function findAll(node, predicate, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  findAll(node.props?.children, predicate, out)
  return out
}

/**
 * Flatten an element tree into its visible strings.
 * @param node - element, array, or primitive.
 * @returns the joined text.
 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** A dictionary reader that echoes keys, so assertions stay copy-independent. */
const t = (key) => key

/** The form snapshot the page owner supplies for a ready, writable entry. */
function makeState(overrides = {}) {
  return {
    status: 'ready',
    writable: true,
    revision: 7,
    value: {
      maxRetries: 0,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      jitterRatio: 0.1,
      respectRetryAfter: true,
      configErrorBehavior: 'delegate',
      logRetries: true,
    },
    base: {
      maxRetries: 0,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      jitterRatio: 0.1,
      respectRetryAfter: true,
      configErrorBehavior: 'delegate',
      logRetries: true,
    },
    user: {},
    ...overrides,
  }
}

/**
 * Build a dictionary reader over one shipped dictionary, with `{name}`
 * interpolation, so form copy is exercised with real strings.
 * @param dictionary - `zh` or `en`.
 * @returns the reader.
 */
function makeT(dictionary) {
  return (key, vars) => {
    const template = dictionary[key]
    assert.equal(typeof template, 'string', `missing copy for "${key}"`)
    return template.replace(/\{(\w+)\}/g, (whole, name) => String(vars?.[name] ?? whole))
  }
}

/**
 * Build a fake browser context whose services record what they receive.
 * @returns the context and the recorded registrations.
 */
function createCtx() {
  const registered = []
  const dictionaries = new Map()
  const disposers = []
  const ctx = {
    locale: {
      register(namespace, dictionary) {
        dictionaries.set(namespace, dictionary)
        return () => dictionaries.delete(namespace)
      },
      bind(namespace) {
        return (key) => `${namespace}:${key}`
      },
    },
    slots: {
      inject(name, factory) {
        const dispose = factory()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {
          const index = registered.findIndex((entry) => entry.options === options)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(factory, label) {
      disposers.push({ label, dispose: factory() })
      return () => {}
    },
  }
  return { ctx, registered, dictionaries, disposers }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the browser half declares its services and registers the row page', () => {
  const mod = loadModule()
  assert.deepEqual(mod.inject, ['slots', 'locale'])

  const { ctx, registered, dictionaries } = createCtx()
  mod.apply(ctx)

  assert.equal(registered.length, 1)
  const [{ options, component }] = registered
  assert.equal(options.name, 'plugins.row.config')
  assert.equal(options.key, 'dsh-llm-retry-boost#llm-retry-boost')
  assert.equal(options.locale, 'llm-retry-boost')
  assert.equal(typeof component, 'function')

  const dictionary = dictionaries.get('llm-retry-boost')
  assert.ok(dictionary.zh.title.length > 0)
  assert.ok(dictionary.en.title.length > 0)
  assert.equal(dictionary.en.title, 'Infinite retry (capped backoff)')
})

test('disposal removes the page registration and the dictionaries', () => {
  const mod = loadModule()
  const { ctx, registered, dictionaries, disposers } = createCtx()
  mod.apply(ctx)
  assert.equal(registered.length, 1)

  for (const { dispose } of disposers) {
    if (typeof dispose === 'function') dispose()
  }
  assert.equal(registered.length, 0)
  assert.equal(dictionaries.size, 0)
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('the page renders every operator-facing field with its effective value', () => {
  const mod = loadModule()
  const tree = mod.__test.form({ t, view: 'page', form: { state: makeState(), mutate: async () => true } })

  const controls = findAll(tree, (node) => typeof node.props?.id === 'string' && node.props.id.startsWith('dsh-lrb-'))
  const byId = new Map(controls.map((node) => [node.props.id, node.props]))
  assert.deepEqual([...byId.keys()].sort(), [
    'dsh-lrb-configErrorBehavior',
    'dsh-lrb-initialDelayMs',
    'dsh-lrb-jitterRatio',
    'dsh-lrb-logRetries',
    'dsh-lrb-maxDelayMs',
    'dsh-lrb-maxRetries',
    'dsh-lrb-respectRetryAfter',
  ])

  assert.equal(byId.get('dsh-lrb-maxRetries').value, '0')
  assert.equal(byId.get('dsh-lrb-initialDelayMs').value, '1000')
  assert.equal(byId.get('dsh-lrb-maxDelayMs').value, '60000')
  assert.equal(byId.get('dsh-lrb-jitterRatio').value, '0.1')
  assert.equal(byId.get('dsh-lrb-respectRetryAfter').checked, true)
  assert.equal(byId.get('dsh-lrb-configErrorBehavior').value, 'delegate')

  const markup = textOf(tree)
  // The row switch owns on/off, the allow-lists stay in YAML: neither is a form
  // field here, and the unit suffix belongs to the numeric controls.
  assert.ok(!markup.includes('dsh-lrb-enabled'))
  assert.ok(!markup.includes('retryableCodes'))
  assert.ok(!markup.includes('retryableHttpStatuses'))
  assert.ok(markup.includes('initialDelayMsHint'))
  assert.ok(markup.includes('unitMs'))
  assert.ok(markup.includes('unitTimes'))
})

test('the page marks an overridden field and offers a reset', () => {
  const mod = loadModule()
  const tree = mod.__test.form({
    t,
    view: 'page',
    form: { state: makeState({ user: { maxRetries: 3 } }), mutate: async () => true },
  })
  const markup = textOf(tree)
  assert.ok(markup.includes('overridden'))
  assert.ok(markup.includes('reset'))

  const save = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0]
  assert.equal(save.props.disabled, true, 'nothing staged yet, so save stays disabled')
})

test('a read-only or unavailable form never offers a save', () => {
  const mod = loadModule()
  const readOnly = mod.__test.form({
    t,
    view: 'page',
    form: { state: makeState({ writable: false }), mutate: async () => true },
  })
  const save = findAll(readOnly, (node) => node.type === 'button' && textOf(node) === 'save')[0]
  assert.equal(save.props.disabled, true)
  assert.ok(textOf(readOnly).includes('readOnly'))

  const unavailable = mod.__test.form({ t, view: 'page', form: undefined })
  assert.equal(textOf(unavailable), 'unavailable')

  const loading = mod.__test.form({
    t,
    view: 'page',
    form: { state: makeState({ status: 'loading' }), mutate: async () => true },
  })
  assert.equal(textOf(loading), 'loading')

  const summary = mod.__test.form({ t, view: 'summary', form: { state: makeState() } })
  assert.equal(summary, 'summary')
})

// ---------------------------------------------------------------------------
// The write contract
// ---------------------------------------------------------------------------

test('one save carries exactly the changed fields', () => {
  const { buildOps, draftFrom } = loadModule().__test
  const state = makeState()

  assert.deepEqual(buildOps(state, draftFrom(state), new Set()), { ops: [], errors: {} })

  const draft = { ...draftFrom(state), maxRetries: '3', initialDelayMs: '250', respectRetryAfter: false }
  assert.deepEqual(buildOps(state, draft, new Set()), {
    ops: [
      { op: 'set', path: ['maxRetries'], value: 3 },
      { op: 'set', path: ['initialDelayMs'], value: 250 },
      { op: 'set', path: ['respectRetryAfter'], value: false },
    ],
    errors: {},
  })

  // A number typed as an equal value is not a change.
  assert.deepEqual(buildOps(state, { ...draftFrom(state), initialDelayMs: '1000' }, new Set()).ops, [])
})

test('a reset unsets the override instead of writing the default', () => {
  const { buildOps, draftFrom } = loadModule().__test
  const state = makeState({ user: { maxRetries: 3 }, value: { ...makeState().value, maxRetries: 3 } })
  const ops = buildOps(state, draftFrom(state), new Set(['maxRetries'])).ops
  assert.deepEqual(ops, [{ op: 'unset', path: ['maxRetries'] }])
})

test('invalid numbers are reported per field and never written', () => {
  const { buildOps, draftFrom } = loadModule().__test
  const state = makeState()
  const draft = { ...draftFrom(state), maxRetries: '1.5', initialDelayMs: '50', jitterRatio: '2', maxDelayMs: 'abc' }
  const { ops, errors } = buildOps(state, draft, new Set())

  assert.deepEqual(ops, [])
  assert.equal(errors.maxRetries, 'invalidInteger')
  assert.equal(errors.initialDelayMs, 'invalidNumber')
  assert.equal(errors.jitterRatio, 'invalidRange')
  assert.equal(errors.maxDelayMs, 'invalidNumber')
})

test('field parsing mirrors the Host validation bounds', () => {
  const { parseField, FIELDS } = loadModule().__test
  const field = (key) => FIELDS.find((candidate) => candidate.key === key)

  assert.equal(parseField(field('maxRetries'), '0'), 0)
  assert.equal(parseField(field('maxRetries'), '-1'), undefined)
  assert.equal(parseField(field('initialDelayMs'), '99'), undefined)
  assert.equal(parseField(field('initialDelayMs'), '100'), 100)
  assert.equal(parseField(field('jitterRatio'), '0.5'), 0.5)
  assert.equal(parseField(field('configErrorBehavior'), 'bounded'), 'bounded')
  assert.equal(parseField(field('configErrorBehavior'), 'forever'), undefined)
  assert.equal(parseField(field('respectRetryAfter'), true), true)
})

test('every field and section has copy in both languages', () => {
  const mod = loadModule()
  const { FIELDS, SECTIONS, dictionaries } = mod.__test
  const chrome = [
    'title', 'summary', 'intro', 'budget', 'budgetHint', 'wait', 'waitHint', 'other',
    'behaviorDelegate', 'behaviorBounded', 'unitMs', 'unitTimes',
    'preview', 'previewInvalid', 'attemptsUnlimited', 'attemptsLimited',
    'save', 'saving', 'saved', 'discard', 'reset', 'overridden', 'defaultTag',
    'invalidNumber', 'invalidInteger', 'invalidRange', 'saveFailed',
    'loading', 'unavailable', 'readOnly',
  ]

  for (const [language, dictionary] of Object.entries(dictionaries)) {
    assert.equal(typeof dictionary.title, 'string', `${language}: title must not be empty`)
    for (const key of chrome) {
      assert.equal(typeof dictionary[key], 'string', `${language}: missing copy for "${key}"`)
    }
    for (const section of SECTIONS) {
      assert.equal(typeof dictionary[section], 'string', `${language}: missing section "${section}"`)
    }
    for (const field of FIELDS) {
      assert.equal(typeof dictionary[field.key], 'string', `${language}: missing label for "${field.key}"`)
      assert.equal(typeof dictionary[`${field.key}Hint`], 'string', `${language}: missing hint for "${field.key}"`)
    }
  }
})

test('the preview line describes the curve the draft would produce', () => {
  const mod = loadModule()
  const { previewOf, draftFrom } = mod.__test
  const tEn = makeT(mod.__test.dictionaries.en)
  const state = makeState()

  assert.equal(
    previewOf(draftFrom(state), tEn),
    'Current: unlimited, first wait 1s, doubling, capped at 60s, jitter ±10%',
  )

  const staged = { ...draftFrom(state), maxRetries: '3', initialDelayMs: '250', maxDelayMs: '900000', jitterRatio: '0.25' }
  assert.equal(
    previewOf(staged, tEn),
    'Current: at most 3 times, first wait 250ms, doubling, capped at 900s, jitter ±25%',
  )

  assert.equal(
    previewOf({ ...draftFrom(state), initialDelayMs: 'abc' }, tEn),
    mod.__test.dictionaries.en.previewInvalid,
  )
})


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
process.exitCode = failures === 0 ? 0 : 1
