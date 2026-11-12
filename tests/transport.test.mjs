import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchThroughProxy, parseProxyUrl } from '../transport.js'
import { startHttpProxy, startSocksProxy, startTargetServer } from './servers.mjs'

test('parseProxyUrl accepts supported schemes and normalizes credentials', () => {
  const socks = parseProxyUrl('socks5h://user:p%40ss@127.0.0.1:1080')
  assert.equal(socks.kind, 'socks')
  assert.equal(socks.remoteDns, true)
  assert.equal(socks.username, 'user')
  assert.equal(socks.password, 'p@ss')
  assert.equal(socks.authorization, `Basic ${Buffer.from('user:p@ss').toString('base64')}`)

  const http = parseProxyUrl('http://127.0.0.1:8080')
  assert.equal(http.kind, 'http')
  assert.equal(http.port, 8080)
  assert.equal(http.authorization, undefined)

  assert.equal(parseProxyUrl('socks5://127.0.0.1').port, 1080)
  assert.equal(parseProxyUrl('https://proxy.example:8443').secure, true)

  for (const bad of ['', 'not a url', 'ftp://127.0.0.1:21', 'http://127.0.0.1:0', 'http://127.0.0.1:8080/path', 'socks5://:1080']) {
    assert.throws(() => parseProxyUrl(bad), undefined, bad)
  }
})

test('HTTP target through an HTTP proxy uses absolute-form forwarding', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(
    `${target.url}/echo`,
    { headers: { 'x-custom': 'from-caller' } },
    { proxyUrl: proxy.url },
  )
  assert.equal(response.status, 200)
  assert.equal(response.url, `${target.url}/echo`)
  const body = await response.json()
  assert.equal(body.method, 'GET')
  assert.equal(body.headers['x-custom'], 'from-caller')
  assert.equal(proxy.proxied.length, 1)
  assert.equal(proxy.proxied[0].url, `${target.url}/echo`)
})

test('POST body and content-type survive the proxy hop', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(
    `${target.url}/post`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    { proxyUrl: proxy.url },
  )
  const body = await response.json()
  assert.equal(body.method, 'POST')
  assert.equal(body.body, '{"a":1}')
  assert.equal(body.headers['content-type'], 'application/json')
  assert.equal(body.headers['content-length'], '7')
})

test('hop-by-hop request headers are dropped and connection is closed per request', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  await fetchThroughProxy(
    `${target.url}/hop`,
    { headers: { connection: 'keep-alive', 'proxy-authorization': 'secret', 'x-keep': 'yes' } },
    { proxyUrl: proxy.url },
  )
  assert.equal(proxy.proxied[0].headers.connection, 'close', 'the proxy sees a one-shot connection')
  assert.equal(target.requests[0].headers['x-keep'], 'yes')
  assert.equal(target.requests[0].headers['proxy-authorization'], undefined)
})

test('proxy authentication is sent to an HTTP proxy from URL credentials', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy({ auth: 'user:pass' })
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(
    `${target.url}/auth`,
    undefined,
    { proxyUrl: `http://user:pass@127.0.0.1:${proxy.port}` },
  )
  assert.equal(response.status, 200)
  assert.equal(proxy.proxied[0].proxyAuthorization, `Basic ${Buffer.from('user:pass').toString('base64')}`)
})

test('SOCKS5 without authentication reaches the target', async (t) => {
  const target = await startTargetServer()
  const proxy = await startSocksProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`${target.url}/socks`, undefined, { proxyUrl: proxy.url })
  assert.equal(response.status, 200)
  assert.equal(proxy.connections.length, 1)
  assert.equal(proxy.connections[0].atyp, 0x01, 'socks5 resolves locally and sends an IPv4 address')
  assert.equal(proxy.connections[0].host, '127.0.0.1')
})

test('SOCKS5H delegates DNS resolution to the proxy by sending the hostname', async (t) => {
  const target = await startTargetServer()
  const proxy = await startSocksProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`${target.url}/socksh`, undefined, {
    proxyUrl: `socks5h://127.0.0.1:${proxy.port}`,
  })
  assert.equal(response.status, 200)
  assert.equal(proxy.connections[0].atyp, 0x03)
  assert.equal(proxy.connections[0].host, '127.0.0.1')
})

test('SOCKS5 username/password authentication is negotiated', async (t) => {
  const target = await startTargetServer()
  const proxy = await startSocksProxy({ username: 'alice', password: 's3cret' })
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`${target.url}/socksauth`, undefined, { proxyUrl: proxy.url })
  assert.equal(response.status, 200)
  assert.equal(proxy.connections.length, 1)
})

test('gzip responses are decoded back to plain bodies', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`${target.url}/gzip`, undefined, { proxyUrl: proxy.url })
  assert.equal(response.headers.get('content-encoding'), null)
  assert.deepEqual(await response.json(), { ok: true, method: 'gzip' })
})

test('streaming responses are delivered incrementally', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`${target.url}/stream`, undefined, { proxyUrl: proxy.url })
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let reads = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    reads += 1
    text += decoder.decode(value, { stream: true })
  }
  assert.ok(reads >= 2, 'the body must arrive in several chunks')
  assert.match(text, /event: start/)
  assert.match(text, /data: done/)
})

test('abort signals cancel an in-flight proxied request', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const controller = new AbortController()
  const pending = fetchThroughProxy(`${target.url}/slow`, { signal: controller.signal }, { proxyUrl: proxy.url }).then(
    async (response) => {
      // Headers may arrive before the abort; consuming the body must surface the abort.
      await response.text()
      return response
    },
  )
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, (error) => error?.name === 'AbortError')
})

test('redirects are followed by default and reported on the response', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`${target.url}/redirect`, undefined, { proxyUrl: proxy.url })
  assert.equal(response.status, 200)
  assert.equal(response.redirected, true)
  assert.equal(response.url, `${target.url}/`)
  const body = await response.json()
  assert.equal(body.url, '/')
})

test('manual redirect mode returns the 3xx response untouched', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`${target.url}/redirect`, { redirect: 'manual' }, { proxyUrl: proxy.url })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/')
})

test('204 responses expose no body', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`${target.url}/nocontent`, undefined, { proxyUrl: proxy.url })
  assert.equal(response.status, 204)
  assert.equal(response.body, null)
})

test('multiple Set-Cookie headers survive response shaping', async (t) => {
  const target = await startTargetServer()
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`${target.url}/cookies`, undefined, { proxyUrl: proxy.url })
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  assert.deepEqual(cookies.sort(), ['a=1', 'b=2'])
})

test('non-HTTP targets and unreachable proxies fail with a clear error', async (t) => {
  const target = await startTargetServer()
  t.after(() => target.close())
  await assert.rejects(
    fetchThroughProxy('data:text/plain,hello', undefined, { proxyUrl: 'http://127.0.0.1:1' }),
    /不支持的协议/,
  )
  await assert.rejects(fetchThroughProxy(`${target.url}/`, undefined, { proxyUrl: 'http://127.0.0.1:1' }))
})
