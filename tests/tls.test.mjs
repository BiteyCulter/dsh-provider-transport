import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchThroughProxy } from '../transport.js'
import { startHttpProxy, startHttpsTargetServer, startSocksProxy } from './servers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const keyPath = join(here, '.certs', 'key.pem')
const certPath = join(here, '.certs', 'cert.pem')
const available = existsSync(keyPath) && existsSync(certPath)
const key = available ? readFileSync(keyPath) : undefined
const cert = available ? readFileSync(certPath) : undefined

test('HTTPS target through an HTTP CONNECT proxy', { skip: !available }, async (t) => {
  const target = await startHttpsTargetServer({ key, cert })
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`https://127.0.0.1:${target.port}/secure`, undefined, {
    proxyUrl: proxy.url,
    tlsOptions: { ca: cert },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { secure: true, url: '/secure' })
  assert.equal(proxy.tunnels.length, 1)
  assert.equal(proxy.tunnels[0].authority, `127.0.0.1:${target.port}`)
  assert.equal(proxy.proxied.length, 0, 'HTTPS models use CONNECT, not absolute-form')
})

test('HTTPS target through a SOCKS5H proxy', { skip: !available }, async (t) => {
  const target = await startHttpsTargetServer({ key, cert })
  const proxy = await startSocksProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`https://127.0.0.1:${target.port}/secure`, undefined, {
    proxyUrl: `socks5h://127.0.0.1:${proxy.port}`,
    tlsOptions: { ca: cert },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { secure: true, url: '/secure' })
  assert.equal(proxy.connections[0].atyp, 0x03)
  assert.equal(proxy.connections[0].port, target.port)
})


test('HTTPS streaming stays incremental through a CONNECT proxy', { skip: !available }, async (t) => {
  const target = await startHttpsTargetServer({ key, cert })
  const proxy = await startHttpProxy()
  t.after(async () => {
    await target.close()
    await proxy.close()
  })
  const response = await fetchThroughProxy(`https://127.0.0.1:${target.port}/stream`, undefined, {
    proxyUrl: proxy.url,
    tlsOptions: { ca: cert },
  })
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
  assert.ok(reads >= 2, 'the TLS body must arrive in several chunks')
  assert.match(text, /data: first/)
  assert.match(text, /data: done/)
})
