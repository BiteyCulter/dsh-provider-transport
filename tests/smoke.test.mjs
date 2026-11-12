import test from 'node:test'
import assert from 'node:assert/strict'
import { startHttpProxy, startTargetServer } from './servers.mjs'

// The host entry imports schemastery, which DSH provides through its profile
// resolution. A plain Node process can only load it when the DSH package tree
// (or a development copy of the peer dependencies) is resolvable; otherwise
// this smoke suite skips instead of failing, because it tests the installed
// plugin rather than the standalone module graph.
const plugin = await import('../index.js').catch((error) => {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  console.error('smoke: @deepseek-ai/schemastery is not resolvable here; run this suite inside a DSH profile or provide the peer dependencies')
  return undefined
})
const skip = plugin === undefined ? 'needs the DSH-provided @deepseek-ai/schemastery' : false

function harness() {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    logger: { warn() {}, info() {} },
  }
  return {
    ctx,
    listener(name) {
      return listeners.get(name)?.[0]
    },
    dispose() {
      while (disposers.length > 0) disposers.pop()?.()
    },
  }
}

function configOf(providers) {
  return plugin.Config({ providers })
}

/** Drive one fake model stream: prepare headers, then perform the SDK fetch. */
function streamOf(listener, headersListener, options, url) {
  const next = () =>
    (async function* () {
      const headers = new Headers({ 'x-native': '1' })
      if (headersListener !== undefined) {
        headersListener(
          { provider: options.provider, model: options.model, baseURL: url, sessionId: 'sess-1', purpose: 'chat' },
          headers,
          () => headers,
        )
      }
      const response = await globalThis.fetch(url, { method: 'POST', body: '{}', headers })
      yield { status: response.status, json: await response.json() }
    })()
  return listener(options, next)
}

test('plugin exports one live settings namespace and no service dependency', { skip }, () => {
  assert.equal(plugin.name, 'dsh-provider-transport')
  assert.deepEqual(plugin.inject, [])
  const config = configOf({
    acme: { proxy: { mode: 'proxy', url: 'http://127.0.0.1:1' }, headers: { 'x-a': '1' } },
  })
  assert.equal(typeof config.providers.get, 'function')
  assert.equal(config.providers.get().acme.headers['x-a'], '1')
  assert.deepEqual(configOf({}).providers.get(), {})
})

test('pi-ai request learns the endpoint origin, proxies it and applies headers + macros', { skip }, async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const h = harness()
  plugin.apply(
    h.ctx,
    configOf({
      acme: {
        headers: { 'x-session': '${sessionId}', 'x-fixed': 'yes' },
        proxy: { mode: 'proxy', url: proxy.url },
      },
    }),
  )
  const options = { provider: 'acme', model: 'fast', sessionId: 'sess-1', purpose: 'chat' }
  const stream = streamOf(h.listener('llm/stream'), h.listener('llm-pi-ai/request-headers'), options, `${target.url}/v1/chat`)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].status, 200)
  assert.equal(chunks[0].json.headers['x-session'], 'sess-1')
  assert.equal(chunks[0].json.headers['x-fixed'], 'yes')
  assert.equal(chunks[0].json.headers['x-native'], '1')
  assert.equal(proxy.proxied.length, 1, 'the model request must travel through the proxy')
  assert.equal(h.listener('llm/stream') !== undefined, true)
  h.dispose()
})

test('header-only providers stay on the native fetch and only add headers', { skip }, async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const h = harness()
  plugin.apply(h.ctx, configOf({ plain: { headers: { 'x-plain': 'on' } } }))
  const options = { provider: 'plain', model: 'any', sessionId: 's' }
  const stream = streamOf(h.listener('llm/stream'), h.listener('llm-pi-ai/request-headers'), options, `${target.url}/v1/plain`)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks[0].json.headers['x-plain'], 'on')
  assert.equal(proxy.proxied.length, 0, 'no proxy was configured for this provider')
  h.dispose()
})

test('first-party deepseek adapters are routed whole-scope without the pi-ai header event', { skip }, async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const h = harness()
  plugin.apply(
    h.ctx,
    configOf({ 'deepseek-official': { headers: { 'x-scope': '${provider}' }, proxy: { mode: 'proxy', url: proxy.url } } }),
  )
  const options = { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 's' }
  const stream = streamOf(h.listener('llm/stream'), undefined, options, `${target.url}/anthropic/v1/messages`)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks[0].status, 200)
  assert.equal(chunks[0].json.headers['x-scope'], 'deepseek-official')
  assert.equal(proxy.proxied.length, 1)
  h.dispose()
})

test('fetches outside a model stream are never rewritten', { skip }, async (t) => {
  const target = await startTargetServer()
  t.after(async () => {
    await target.close()
  })
  const h = harness()
  plugin.apply(h.ctx, configOf({ acme: { headers: { 'x-leak': 'no' } } }))
  const response = await globalThis.fetch(`${target.url}/outside`)
  const body = await response.json()
  assert.equal(body.headers['x-leak'], undefined)
  h.dispose()
})

test('a stream for an unconfigured provider is untouched', { skip }, async (t) => {
  const target = await startTargetServer()
  t.after(async () => {
    await target.close()
  })
  const h = harness()
  plugin.apply(h.ctx, configOf({ configured: { headers: { 'x-a': '1' } } }))
  const options = { provider: 'other', model: 'm' }
  const stream = streamOf(h.listener('llm/stream'), undefined, options, `${target.url}/v1/other`)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks[0].json.headers['x-a'], undefined)
  h.dispose()
})

test('an invalid saved proxy fails the model request with a provider-transport error', { skip }, async () => {
  const h = harness()
  plugin.apply(h.ctx, configOf({ broken: { proxy: { mode: 'proxy', url: 'not-a-url' } } }))
  const listener = h.listener('llm/stream')
  assert.throws(
    () => listener({ provider: 'broken', model: 'm' }, () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) })),
    /provider-transport/,
  )
  h.dispose()
})

test('plugin disposal restores the original global fetch', { skip }, () => {
  const original = globalThis.fetch
  const h = harness()
  plugin.apply(h.ctx, configOf({}))
  assert.notEqual(globalThis.fetch, original)
  h.dispose()
  assert.equal(globalThis.fetch, original)
})
