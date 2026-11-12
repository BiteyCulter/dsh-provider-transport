#!/usr/bin/env node
/**
 * Local header probe for dsh-provider-transport.
 *
 * Runs two loopback listeners:
 *   - an upstream "fake provider" that records every request (method, path,
 *     headers, body) and answers with a minimal OpenAI/Anthropic SSE stream,
 *     so a DSH model call can complete while you inspect what was sent;
 *   - an HTTP forward proxy that records the absolute URL and headers of
 *     plain-HTTP requests, and tunnels CONNECT without exposing its headers.
 *
 * Open http://127.0.0.1:18080/ for a live dashboard, or watch the terminal.
 */
import http from 'node:http'
import net from 'node:net'
import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '18080' },
    'proxy-port': { type: 'string', default: '18081' },
    file: { type: 'string', default: 'probe-capture.jsonl' },
    'no-proxy': { type: 'boolean', default: false },
    'max-entries': { type: 'string', default: '200' },
  },
})

const upstreamPort = Number(values.port)
const proxyPort = Number(values['proxy-port'])
const captureFile = values.file
const maxEntries = Number(values['max-entries']) || 200
const entries = []
let nextId = 1

function remember(source, method, url, headers, body) {
  const entry = {
    id: nextId++,
    at: new Date().toISOString(),
    source,
    method,
    url,
    headers,
    body,
  }
  entries.push(entry)
  while (entries.length > maxEntries) entries.shift()
  try {
    appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
  } catch {
    // The dashboard still works when the file cannot be written.
  }
  const interesting = Object.entries(headers)
    .filter(([name]) => !['host', 'connection', 'content-length', 'accept-encoding'].includes(name))
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n    ')
  console.log(`\n[probe] #${entry.id} via ${source} ${method} ${url}\n    ${interesting || '(no headers)'}`)
  if (body) console.log(`    body: ${body.slice(0, 160).replace(/\s+/g, ' ')}`)
  return entry
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/* --------------------------- fake provider --------------------------- */

function openAiStream(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const created = Math.floor(Date.now() / 1000)
  const chunk = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`)
  chunk({
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created,
    model: 'probe-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'probe ok' }, finish_reason: null }],
  })
  chunk({
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created,
    model: 'probe-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })
  response.end('data: [DONE]\n\n')
}

function anthropicStream(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const event = (name, payload) => response.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
  event('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_probe',
      type: 'message',
      role: 'assistant',
      model: 'probe-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  event('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'probe ok' },
  })
  event('content_block_stop', { type: 'content_block_stop', index: 0 })
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  })
  event('message_stop', { type: 'message_stop' })
  response.end()
}

function models(response) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      object: 'list',
      data: [{ id: 'probe-model', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'probe' }],
    }),
  )
}

const upstream = http.createServer(async (request, response) => {
  if (request.method === 'GET' && (request.url === '/' || request.url === '/index.html')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(dashboardHtml())
    return
  }
  if (request.method === 'GET' && request.url === '/_probe/data') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(entries, null, 2))
    return
  }
  const body = await readBody(request)
  remember('upstream', request.method, request.url, request.headers, body)
  const path = request.url ?? ''
  if (path.includes('/chat/completions')) return openAiStream(response)
  if (path.includes('/messages')) return anthropicStream(response)
  if (path.endsWith('/models') || path.includes('/models?')) return models(response)
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true, probe: true, note: 'request captured' }))
})

upstream.on('upgrade', (request, socket) => {
  socket.destroy()
})

/* --------------------------- forward proxy --------------------------- */

const forward = http.createServer(async (request, response) => {
  const body = await readBody(request)
  const target = request.url ?? ''
  remember('forward-proxy', request.method, target, request.headers, body)
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    response.writeHead(400)
    response.end('forward proxy expects an absolute-form URL')
    return
  }
  const upstreamHeaders = { ...request.headers }
  for (const name of ['connection', 'proxy-connection', 'proxy-authorization', 'transfer-encoding']) {
    delete upstreamHeaders[name]
  }
  const client = http.request(
    {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: request.method,
      headers: upstreamHeaders,
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(response)
    },
  )
  client.on('error', () => {
    response.writeHead(502)
    response.end('forward proxy upstream failed')
  })
  if (body.length > 0) client.write(body)
  client.end()
})

forward.on('connect', (request, clientSocket) => {
  const authority = request.url ?? ''
  remember('forward-proxy CONNECT', 'CONNECT', authority, request.headers, '')
  const index = authority.lastIndexOf(':')
  const host = authority.slice(0, index)
  const port = Number(authority.slice(index + 1))
  const upstreamSocket = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
  })
  upstreamSocket.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstreamSocket.destroy())
})

/* ----------------------------- dashboard ----------------------------- */

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
}

function dashboardHtml() {
  const rows = [...entries]
    .reverse()
    .map((entry) => {
      const headers = Object.entries(entry.headers)
        .map(([name, value]) => `<span class="h">${escapeHtml(name)}</span>: ${escapeHtml(value)}`)
        .join('\n')
      return `<article>
  <header>#${entry.id} · ${escapeHtml(entry.at)} · <b>${escapeHtml(entry.source)}</b> · ${escapeHtml(entry.method)} ${escapeHtml(entry.url)}</header>
  <pre>${headers}</pre>
  ${entry.body ? `<details><summary>body</summary><pre>${escapeHtml(entry.body.slice(0, 2000))}</pre></details>` : ''}
</article>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>dsh-provider-transport probe</title>
<meta http-equiv="refresh" content="2">
<style>
  :root { color-scheme: dark light }
  body { font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 4px }
  p.note { margin: 0 0 18px; opacity: .7 }
  article { border: 1px solid #8884; border-radius: 8px; padding: 10px 12px; margin: 10px 0 }
  article header { font-weight: 600; margin-bottom: 6px; word-break: break-all }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; background: #8881; padding: 8px; border-radius: 6px }
  .h { color: #58a6ff }
  details { margin-top: 6px }
  summary { cursor: pointer; opacity: .7 }
</style>
<h1>dsh-provider-transport · header probe</h1>
<p class="note">${entries.length} 条请求 / captured requests · 自动刷新 / auto-refresh 2s · <a href="/_probe/data">JSON</a></p>
${rows || '<p>还没有请求。按 README 把 Provider baseURL 指到本服务，然后发一条消息。<br>No requests yet. Point a provider baseURL here and send a message.</p>'}
</html>`
}

/* ------------------------------- start -------------------------------- */

upstream.listen(upstreamPort, '127.0.0.1', () => {
  console.log(`\n[probe] fake provider:  http://127.0.0.1:${upstreamPort}`)
  console.log(`[probe] dashboard:      http://127.0.0.1:${upstreamPort}/`)
  console.log(`[probe] capture file:   ${captureFile}`)
})
forward.listen(proxyPort, '127.0.0.1', () => {
  console.log(`[probe] forward proxy:  http://127.0.0.1:${proxyPort}`)
  console.log(`
[probe] 验证请求头 / verify headers:
  1. 设置 → 模型 → 新建自定义 Provider，baseURL 填 http://127.0.0.1:${upstreamPort}/v1
  2. 在该 Provider 的「网络代理与请求头」里加一个测试头，例如 x-dsh-probe: \${provider}/\${model}，保存
  3. 用这个 Provider 发一条消息，回到 dashboard 或终端查看收到的 header
  4. 验证代理：把 Proxy 设为 http://127.0.0.1:${proxyPort}，再发一次，forward-proxy 记录里会有第二份请求
`)
})

if (values['no-proxy']) forward.close()

function shutdown() {
  console.log('\n[probe] bye')
  upstream.close()
  forward.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
