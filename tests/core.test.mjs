import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyHeaders,
  configIsEmpty,
  modelIsEmpty,
  mergedHeaders,
  resolveHeaderValues,
  resolveRoute,
  validateHeaders,
  validateProvider,
  validateProxy,
} from '../core.js'

test('provider defaults, model opt-outs and model overrides compose by exact id', () => {
  const providers = {
    acme: {
      proxy: { mode: 'proxy', url: 'socks5h://192.168.2.24:30800' },
      headers: { 'X-Trace': '${sessionId}', 'X-Provider': '${provider}' },
      models: {
        fast: { proxy: { mode: 'direct' }, headers: { 'x-trace': 'constant' }, removeHeaders: ['x-provider'] },
        slow: { headers: { 'X-Model': '${model}' } },
      },
    },
  }
  const slow = resolveRoute(providers, 'acme', 'slow')
  assert.equal(slow.proxyUrl, 'socks5h://192.168.2.24:30800')
  assert.deepEqual(resolveHeaderValues(slow.headers, { provider: 'acme', model: 'slow', sessionId: 's1' }), {
    'X-Trace': 's1',
    'X-Provider': 'acme',
    'X-Model': 'slow',
  })
  const fast = resolveRoute(providers, 'acme', 'fast')
  assert.equal(fast.proxyMode, 'direct')
  assert.equal(fast.proxyUrl, undefined)
  assert.deepEqual(resolveHeaderValues(fast.headers, { provider: 'acme', model: 'fast', sessionId: 's1' }), {
    'x-trace': 'constant',
  })
  assert.deepEqual(resolveRoute(providers, 'unconfigured', 'whatever').headers, {})
  assert.equal(resolveRoute(providers, 'unconfigured', 'whatever').proxyUrl, undefined)
})

test('model proxy inherits provider proxy unless the model explicitly chooses', () => {
  const providers = {
    p: {
      proxy: { mode: 'proxy', url: 'http://127.0.0.1:8888' },
      models: {
        inherited: {},
        direct: { proxy: { mode: 'direct' } },
        custom: { proxy: { mode: 'proxy', url: 'socks5://127.0.0.1:1080' } },
      },
    },
  }
  assert.equal(resolveRoute(providers, 'p', 'inherited').proxyUrl, 'http://127.0.0.1:8888')
  assert.equal(resolveRoute(providers, 'p', 'direct').proxyUrl, undefined)
  assert.equal(resolveRoute(providers, 'p', 'custom').proxyUrl, 'socks5://127.0.0.1:1080')
})

test('a header with a missing dynamic value is omitted, not sent literally or empty', () => {
  assert.deepEqual(
    resolveHeaderValues({ 'x-session': '${sessionId}', 'x-model': '${model}', 'x-fixed': 'ok' }, { model: 'm' }),
    { 'x-model': 'm', 'x-fixed': 'ok' },
  )
  assert.deepEqual(resolveHeaderValues({ 'x-pair': '${provider}/${purpose}' }, { provider: 'p' }), {})
  assert.deepEqual(resolveHeaderValues({ 'x-pair': '${provider}/${purpose}' }, { provider: 'p', purpose: 'chat' }), {
    'x-pair': 'p/chat',
  })
})

test('applyHeaders merges templates over the adapter headers without dropping them', () => {
  const result = applyHeaders({ 'x-a': 'old', authorization: 'Bearer secure' }, { 'X-A': 'new' }, {})
  assert.equal(result.get('x-a'), 'new')
  assert.equal(result.get('authorization'), 'Bearer secure')
  const untouched = applyHeaders(new Headers({ 'x-native': '1' }), {}, {})
  assert.equal(untouched.get('x-native'), '1')
})

test('header validation rejects reserved, invalid, duplicated and unknown-macro headers', () => {
  validateHeaders({ 'x-use': '${sessionId}/${provider}/${model}/${purpose}' })
  assert.throws(() => validateHeaders({ authorization: 'secret' }), /由 DSH 管理/)
  assert.throws(() => validateHeaders({ 'proxy-authorization': 'secret' }), /由 DSH 管理/)
  assert.throws(() => validateHeaders({ 'bad name': 'x' }), /名称无效/)
  assert.throws(() => validateHeaders({ 'x-foo': '${unknownMacro}' }), /不支持的宏/)
  assert.throws(() => validateHeaders({ 'X-foo': 'a', 'x-foo': 'b' }), /重复/)
  assert.throws(() => validateHeaders({ 'x-foo': 'a\r\nb' }), /不能包含换行/)
  assert.throws(() => validateHeaders({ 'x-foo': 42 }), /必须是字符串/)
})

test('proxy validation accepts supported schemes and rejects everything else', () => {
  validateProxy({ mode: 'direct' })
  validateProxy({ mode: 'inherit' })
  validateProxy({ mode: 'proxy', url: 'http://127.0.0.1:8000' })
  validateProxy({ mode: 'proxy', url: 'https://proxy.example:8443' })
  validateProxy({ mode: 'proxy', url: 'socks5://user:pass@127.0.0.1:1080' })
  validateProxy({ mode: 'proxy', url: 'socks5h://host.docker.internal:30800' })
  assert.throws(() => validateProxy({ mode: 'proxy', url: 'bad' }), /不是有效 URL/)
  assert.throws(() => validateProxy({ mode: 'proxy', url: 'file:///tmp/a' }), /仅支持/)
  assert.throws(() => validateProxy({ mode: 'skip', url: 'https://example.com' }), /模式/)
  assert.throws(() => validateProxy({ mode: 'proxy', url: '' }), /不能为空/)
})

test('provider/model validation covers nested proxy, headers and removeHeaders', () => {
  validateProvider({
    proxy: { mode: 'proxy', url: 'http://127.0.0.1:8888' },
    headers: { 'x-a': '1' },
    models: {
      m1: { proxy: { mode: 'direct' }, headers: { 'x-b': '2' }, removeHeaders: ['x-a'] },
      m2: {},
    },
  })
  assert.throws(() => validateProvider(null), /必须是对象/)
  assert.throws(() => validateProvider({ headers: [] }), /必须是键值对象/)
  assert.throws(() => validateProvider({ models: { '': {} } }), /Model ID/)
  assert.throws(() => validateProvider({ models: { m1: { removeHeaders: ['bad name'] } } }), /removeHeaders/)
})

test('mergedHeaders removes inherited entries case-insensitively', () => {
  const merged = mergedHeaders(
    { headers: { 'X-Keep': 'a', 'X-Drop': 'b' } },
    { removeHeaders: ['x-drop'], headers: { 'x-new': 'c' } },
  )
  assert.deepEqual(merged, { 'X-Keep': 'a', 'x-new': 'c' })
})

test('empty provider and model overrides can be deleted without touching native config', () => {
  assert.ok(modelIsEmpty({ proxy: { mode: 'inherit' }, headers: {} }))
  assert.ok(modelIsEmpty({}))
  assert.ok(configIsEmpty({ proxy: { mode: 'inherit' }, models: {} }))
  assert.ok(!configIsEmpty({ models: { m1: { headers: { 'x-test': 'yes' } } } }))
  assert.ok(!configIsEmpty({ proxy: { mode: 'direct' } }))
  assert.ok(!modelIsEmpty({ removeHeaders: ['x-a'] }))
})
