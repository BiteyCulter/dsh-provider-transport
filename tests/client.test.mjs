import test from 'node:test'
import assert from 'node:assert/strict'

test('browser bundle registers one provider-card anchor seat per native transport adapter', async () => {
  let bundle
  globalThis.window = { __ModuleLoader__: { load(spec) { bundle = spec } } }
  try {
    await import('../client.js?case=seats')
    assert.equal(bundle.id, 'dsh-provider-transport')
    const api = bundle.factory((name) => {
      if (name === 'react') return { createElement() {} }
      if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
      throw new Error(`unexpected require: ${name}`)
    })
    assert.deepEqual(api.inject, ['slots', 'remote', 'remote.settings', 'locale'])

    const locales = []
    const registered = []
    const ctx = {
      effect(callback) {
        callback()
        return () => {}
      },
      on() {
        return () => {}
      },
      locale: {
        register(ns, dict) {
          locales.push({ ns, dict })
          return () => {}
        },
        bind(ns) {
          return (key) => key
        },
      },
      slots: {
        inject(name, callback) {
          assert.equal(name, 'settings.models.provider-card')
          callback()
        },
        register(spec, component) {
          registered.push({ spec, component })
          return () => {}
        },
      },
      remote: {
        settings: {
          describe: async () => ({ ok: true, value: { namespaces: [] } }),
          mutate: async () => ({ ok: true, value: {} }),
        },
      },
    }
    api.apply(ctx)

    assert.equal(locales.length, 1)
    assert.equal(locales[0].ns, 'dsh.providerTransport')
    assert.ok(locales[0].dict.zh && locales[0].dict.en)
    assert.deepEqual(registered.map((entry) => entry.spec.key).sort(), [
      'llm-deepseek',
      'llm-deepseek-account',
      'llm-pi-ai',
    ])
    for (const entry of registered) {
      assert.equal(entry.spec.name, 'settings.models.provider-card')
      assert.equal(entry.spec.locale, 'dsh.providerTransport')
      assert.equal(typeof entry.component, 'function')
    }
  } finally {
    delete globalThis.window
  }
})

test('apply is inert without a DOM and cleans up the editor bridge', async () => {
  let bundle
  globalThis.window = { __ModuleLoader__: { load(spec) { bundle = spec } } }
  try {
    await import('../client.js?case=domless')
    const api = bundle.factory((name) => {
      if (name === 'react') return { createElement() {} }
      if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
      return {}
    })
    const disposers = []
    const ctx = {
      effect(callback) {
        disposers.push(callback())
        return () => {}
      },
      on() {
        return () => {}
      },
      locale: { register: () => () => {}, bind: () => (key) => key },
      slots: { inject(name, callback) { callback() }, register: () => () => {} },
      remote: { settings: {} },
    }
    assert.doesNotThrow(() => api.apply(ctx))
    for (const dispose of disposers) assert.equal(typeof dispose, 'function')
    for (const dispose of disposers) assert.doesNotThrow(() => dispose())
  } finally {
    delete globalThis.window
  }
})

test('DOM bridge recognizes native provider editor cards and resolves their provider', async () => {
  let bundle
  globalThis.window = { __ModuleLoader__: { load(spec) { bundle = spec } } }
  try {
    await import('../client.js?case=bridge')
    const api = bundle.factory((name) => {
      if (name === 'react') return { createElement() {} }
      return {}
    })
    const { isEditorCard, submitOf, findAdjacentCard, findCustomCard } = api._internals

    function cardOf({ classes = ['zGbnIq_editor'], hasInput = true, footerButtons = 2, footerHasInput = false, prev = null, next = null } = {}) {
      const buttons = Array.from({ length: footerButtons }, (_, index) => ({ index }))
      const footer = {
        querySelector: (selector) => (footerHasInput && selector.includes('input') ? {} : null),
        querySelectorAll: (selector) => (selector === 'button' ? buttons : []),
      }
      const card = {
        nodeType: 1,
        classList: classes,
        querySelector: (selector) => (hasInput && selector.includes('input') ? {} : null),
        lastElementChild: footer,
        previousElementSibling: prev,
        nextElementSibling: next,
      }
      return { card, footer, buttons }
    }

    const plain = cardOf()
    assert.equal(isEditorCard(plain.card), true)
    assert.equal(submitOf(plain.card), plain.buttons[1], 'the last footer button is the native submit')
    // Detection is structural: CSS-module class names are build-specific and must not matter.
    assert.equal(isEditorCard(cardOf({ classes: [] }).card), true)
    assert.equal(isEditorCard(cardOf({ classes: ['whatever', 'zGbnIq_editor'] }).card), true)
    assert.equal(isEditorCard(cardOf({ hasInput: false }).card), false)
    assert.equal(isEditorCard(cardOf({ footerHasInput: true }).card), false)
    assert.equal(isEditorCard(cardOf({ footerButtons: 1 }).card), false)

    const provider = { provider: 'kimi-coding', settingsNs: 'llm-pi-ai' }
    const anchor = { __dshTransportProvider: provider, previousElementSibling: null }
    const anchored = cardOf({ next: anchor })
    anchor.previousElementSibling = anchored.card
    assert.equal(findAdjacentCard(anchor), anchored.card)

    const custom = cardOf()
    const panel = { querySelectorAll: () => [custom.card] }
    assert.equal(findCustomCard(panel), custom.card)
    assert.equal(findAdjacentCard(cardOf().card), null)
  } finally {
    delete globalThis.window
  }
})
