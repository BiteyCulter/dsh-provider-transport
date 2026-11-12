/**
 * Dependency-free proxied transport, built only on Node built-ins.
 *
 * The host adapters issue their model requests through the process-wide
 * `fetch`. When a provider has a proxy configured, the plugin routes that one
 * request through this module instead:
 *
 *   target <- TCP/TLS <- [HTTP CONNECT | absolute-form | SOCKS5 handshake] <- proxy
 *
 * The response is shaped into a real WHATWG `Response`, so provider SDKs keep
 * seeing a normal fetch result (streaming bodies, headers, `.json()`, abort).
 * No npm package, no undici internals and no version coupling to Node's own
 * fetch implementation are involved.
 */
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import dns from 'node:dns/promises'
import { Readable } from 'node:stream'

const CONNECT_TIMEOUT_MS = 30_000
const MAX_HEAD_BYTES = 64 * 1024
const MAX_REDIRECTS = 10
const HEAD_END = Buffer.from('\r\n\r\n')
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'socks5:': 1080, 'socks5h:': 1080 }
const SOCKS_PROTOCOLS = new Set(['socks5:', 'socks5h:'])
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const SOCKS_ERRORS = {
  1: '一般性失败',
  2: '代理规则不允许',
  3: '网络不可达',
  4: '主机不可达',
  5: '连接被拒绝',
  6: 'TTL 过期',
  7: '代理不支持该命令',
  8: '代理不支持该地址类型',
}

function debugLog(...args) {
  if (process.env.DSH_PROVIDER_TRANSPORT_DEBUG !== '1') return
  console.error('[provider-transport]', ...args)
}

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isIp(hostname) {
  return net.isIP(hostname) !== 0
}

function authorityOf(hostname, port, defaultPort) {
  const host = isIp(hostname) && hostname.includes(':') ? `[${hostname}]` : hostname
  return Number(port) === defaultPort ? host : `${host}:${port}`
}

/**
 * Parse and validate one proxy URL (`http:`, `https:`, `socks5:`, `socks5h:`).
 *
 * @param raw - Proxy URL saved in the plugin configuration.
 * @returns Parsed proxy descriptor used by {@link fetchThroughProxy}.
 * @throws {Error} when the URL is missing, malformed or uses an unsupported scheme.
 */
export function parseProxyUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('Proxy 地址不能为空')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Proxy 地址不是有效 URL')
  }
  const protocol = url.protocol
  if (!Object.hasOwn(DEFAULT_PORTS, protocol)) throw new Error('仅支持 http/https/socks5/socks5h 代理')
  const hostname = unbracket(url.hostname)
  if (hostname.length === 0) throw new Error('Proxy 缺少主机')
  const port = Number(url.port || DEFAULT_PORTS[protocol])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy 端口无效')
  const socks = SOCKS_PROTOCOLS.has(protocol)
  if (!socks && (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0)) {
    throw new Error('Proxy 地址不能包含路径、查询串或片段')
  }
  const username = safeDecode(url.username)
  const password = safeDecode(url.password)
  return {
    protocol,
    hostname,
    port,
    kind: socks ? 'socks' : 'http',
    secure: protocol === 'https:',
    remoteDns: protocol === 'socks5h:',
    username,
    password,
    authorization:
      username.length > 0 || password.length > 0
        ? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
        : undefined,
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Buffered reader for connection-handshake bytes (CONNECT reply, SOCKS reply).
 * Handshake protocols are tiny and line/field based; a shared reader keeps the
 * byte accounting in one place, including bytes left over after the handshake.
 */
class ByteReader {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.failure = undefined
    this.notify = undefined
    this.onData = (chunk) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.wake()
    }
    this.onError = (error) => {
      this.failure ??= error
      this.wake()
    }
    this.onClose = () => {
      this.failure ??= new Error('连接在握手完成前关闭')
      this.wake()
    }
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
    socket.resume()
  }

  wake() {
    const notify = this.notify
    if (notify === undefined) return
    this.notify = undefined
    notify()
  }

  wait() {
    return new Promise((resolve) => {
      this.notify = resolve
    })
  }

  async read(length) {
    while (this.buffer.length < length) {
      if (this.failure) throw this.failure
      await this.wait()
    }
    const out = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return out
  }

  async readHead() {
    for (;;) {
      if (this.failure) throw this.failure
      const index = this.buffer.indexOf(HEAD_END)
      if (index >= 0) {
        const head = this.buffer.subarray(0, index)
        this.buffer = this.buffer.subarray(index + HEAD_END.length)
        return head
      }
      if (this.buffer.length > MAX_HEAD_BYTES) throw new Error('代理响应头过大')
      await this.wait()
    }
  }

  /** Detach the handshake reader and hand the socket back for HTTP framing. */
  release() {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
    const rest = this.buffer
    this.buffer = Buffer.alloc(0)
    if (rest.length > 0) this.socket.unshift(rest)
    this.socket.resume()
    return this.socket
  }
}

function connectTcp(host, port, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const socket = net.connect({ host, port })
    socket.setNoDelay(true)
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.off('error', onError)
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        socket.destroy()
        reject(error)
        return
      }
      resolve(socket)
    }
    const onAbort = () => finish(abortError())
    const onError = (error) => finish(error)
    const timer = setTimeout(() => finish(new Error(`连接 ${host}:${port} 超时`)), CONNECT_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('error', onError)
    socket.once('connect', () => finish())
  })
}

function startTls(socket, hostname, signal, tlsOptions) {
  debugLog('tls connect', hostname)
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      socket.destroy()
      reject(abortError())
      return
    }
    socket.pause()
    const options = { ...tlsOptions, socket }
    if (!Object.hasOwn(options, 'servername')) {
      if (isIp(hostname)) delete options.servername
      else options.servername = hostname
    }
    const secure = tls.connect(options)
    debugLog('tls socket created')
    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      secure.off('error', onError)
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        secure.destroy()
        reject(error)
        return
      }
      // Do NOT pause the TLS socket here: Node's http client does not resume an
      // explicitly paused socket, so the response stream would never be read
      // (request goes out, reply never arrives). The peer sends nothing before
      // the request anyway, so there is no data to lose in this window.
      resolve(secure)
    }
    const onAbort = () => finish(abortError())
    const onError = (error) => finish(error)
    signal?.addEventListener('abort', onAbort, { once: true })
    secure.once('error', onError)
    secure.once('secureConnect', () => { debugLog('tls secureConnect'); finish() })
    secure.once('error', (error) => debugLog('tls error', error?.message))
  })
}

async function httpConnect(socket, target, authorization) {
  const reader = new ByteReader(socket)
  try {
    const authority = authorityOf(target.hostname, target.port, target.secure ? 443 : 80)
    const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
    if (authorization) lines.push(`Proxy-Authorization: ${authorization}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    const head = (await reader.readHead()).toString('latin1')
    debugLog('CONNECT reply', head.split('\r\n')[0] ?? '')
    const statusLine = head.split('\r\n', 1)[0] ?? ''
    const match = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine)
    if (match === null) throw new Error(`代理 CONNECT 响应无效：${statusLine || '空响应'}`)
    const status = Number(match[1])
    if (status !== 200) throw new Error(`代理 CONNECT 被拒绝：${statusLine}`)
  } finally {
    reader.release()
  }
}

function domainAddress(hostname) {
  if (hostname.length === 0) throw new Error('SOCKS 目标主机名为空')
  const raw = Buffer.from(hostname, 'ascii')
  if (raw.length === 0 || raw.length > 255) throw new Error('SOCKS 目标主机名过长')
  return Buffer.concat([Buffer.from([0x03, raw.length]), raw])
}

function ipv4Address(hostname) {
  const parts = hostname.split('.')
  return Buffer.from([0x01, ...parts.map((part) => Number(part) & 0xff)])
}

async function socksAddress(hostname, remoteDns) {
  if (remoteDns) return domainAddress(hostname)
  const family = net.isIP(hostname)
  if (family === 4) return ipv4Address(hostname)
  if (family === 6) return domainAddress(hostname)
  const { address } = await dns.lookup(hostname)
  if (net.isIP(address) === 4) return ipv4Address(address)
  return domainAddress(address)
}

async function socks5Handshake(socket, proxy, target) {
  const reader = new ByteReader(socket)
  try {
    const methods = proxy.username.length > 0 || proxy.password.length > 0 ? [0x00, 0x02] : [0x00]
    socket.write(Buffer.from([0x05, methods.length, ...methods]))
    const greeting = await reader.read(2)
    if (greeting[0] !== 0x05) throw new Error('SOCKS 代理版本不匹配')
    const method = greeting[1]
    if (method === 0x02) {
      const username = Buffer.from(proxy.username, 'utf8')
      const password = Buffer.from(proxy.password, 'utf8')
      if (username.length > 255 || password.length > 255) throw new Error('SOCKS 用户名或密码过长')
      socket.write(
        Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]),
      )
      const verdict = await reader.read(2)
      if (verdict[1] !== 0x00) throw new Error('SOCKS 用户名或密码被拒绝')
    } else if (method !== 0x00) {
      throw new Error(`SOCKS 代理要求不支持的认证方式（0x${method.toString(16)}）`)
    }
    const address = await socksAddress(target.hostname, proxy.remoteDns)
    const port = Number(target.port)
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00]),
        address,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]),
    )
    const reply = await reader.read(4)
    if (reply[0] !== 0x05) throw new Error('SOCKS 代理回复格式错误')
    if (reply[1] !== 0x00) throw new Error(`SOCKS 代理连接失败：${SOCKS_ERRORS[reply[1]] ?? `代码 ${reply[1]}`}`)
    const atyp = reply[3]
    let skip
    if (atyp === 0x01) skip = 4
    else if (atyp === 0x04) skip = 16
    else if (atyp === 0x03) skip = (await reader.read(1))[0]
    else throw new Error(`SOCKS 代理返回未知地址类型（${atyp}）`)
    await reader.read(skip + 2)
  } finally {
    reader.release()
  }
}

function toTarget(url) {
  const secure = url.protocol === 'https:'
  return {
    hostname: unbracket(url.hostname),
    port: Number(url.port || (secure ? 443 : 80)),
    secure,
  }
}

function deadlineError(label) {
  return new Error(`${label} 握手超时（${CONNECT_TIMEOUT_MS / 1000}s）`)
}

/**
 * Open a socket that already reaches the target endpoint, through the proxy if
 * one is configured. HTTPS targets return a TLS socket; HTTP targets behind an
 * HTTP(S) forward proxy return the proxy socket plus `absoluteForm: true`.
 */
async function openTarget(target, proxy, signal, tlsOptions) {
  debugLog('open target', `${target.hostname}:${target.port}`, 'secure', target.secure, 'proxy', proxy === undefined ? 'none' : `${proxy.protocol}//${proxy.hostname}:${proxy.port}`)
  if (proxy === undefined) {
    const raw = await connectTcp(target.hostname, target.port, signal)
    const timer = setTimeout(() => raw.destroy(deadlineError(`连接 ${target.hostname}:${target.port}`)), CONNECT_TIMEOUT_MS)
    try {
      const socket = target.secure ? await startTls(raw, target.hostname, signal, tlsOptions) : raw
      return { socket, absoluteForm: false }
    } catch (error) {
      raw.destroy()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  if (proxy.kind === 'socks') {
    const raw = await connectTcp(proxy.hostname, proxy.port, signal)
    const timer = setTimeout(() => raw.destroy(deadlineError(`SOCKS 代理 ${proxy.hostname}:${proxy.port}`)), CONNECT_TIMEOUT_MS)
    try {
      await socks5Handshake(raw, proxy, target)
      const socket = target.secure ? await startTls(raw, target.hostname, signal, tlsOptions) : raw
      return { socket, absoluteForm: false }
    } catch (error) {
      raw.destroy()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  const proxySocket = proxy.secure
    ? await startTls(await connectTcp(proxy.hostname, proxy.port, signal), proxy.hostname, signal, tlsOptions)
    : await connectTcp(proxy.hostname, proxy.port, signal)
  const timer = setTimeout(() => proxySocket.destroy(deadlineError(`代理 ${proxy.hostname}:${proxy.port}`)), CONNECT_TIMEOUT_MS)
  try {
    if (target.secure) {
      await httpConnect(proxySocket, target, proxy.authorization)
      const socket = await startTls(proxySocket, target.hostname, signal, tlsOptions)
      return { socket, absoluteForm: false }
    }
    return { socket: proxySocket, absoluteForm: true, proxyAuthorization: proxy.authorization }
  } catch (error) {
    proxySocket.destroy()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function headersOf(headers) {
  const result = {}
  for (const [name, value] of headers) result[name] = value
  return result
}

function headerBag(incoming) {
  const headers = new Headers()
  const raw = incoming.rawHeaders
  for (let index = 0; index < raw.length; index += 2) {
    try {
      headers.append(raw[index], raw[index + 1])
    } catch {
      // A malformed upstream header must not break the whole response.
    }
  }
  for (const name of ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    headers.delete(name)
  }
  return headers
}

function decoderFor(encoding) {
  const token = encoding.split(',')[0]?.trim().toLowerCase() ?? ''
  if (token === 'gzip' || token === 'x-gzip') return zlib.createGunzip()
  if (token === 'deflate') return zlib.createInflate()
  if (token === 'br') return zlib.createBrotliDecompress()
  if (token === 'zstd' && typeof zlib.createZstdDecompress === 'function') return zlib.createZstdDecompress()
  return undefined
}

function defineMeta(response, url, redirected) {
  try {
    Object.defineProperty(response, 'url', { value: url, configurable: true })
    Object.defineProperty(response, 'redirected', { value: redirected, configurable: true })
  } catch {
    // Response instances are extensible in supported Node versions; ignore otherwise.
  }
  return response
}

/** Turn one Node response into a real WHATWG Response, decoding content-encoding. */
function buildResponse(incoming, socket, signal, url) {
  const status = incoming.statusCode ?? 502
  const headers = headerBag(incoming)
  const encoding = headers.get('content-encoding')
  let stream = incoming
  if (encoding !== null) {
    const decoder = decoderFor(encoding)
    if (decoder !== undefined) {
      incoming.on('error', (error) => decoder.destroy(error))
      stream = incoming.pipe(decoder)
      headers.delete('content-encoding')
      headers.delete('content-length')
    }
  }

  const destroy = () => {
    if (!socket.destroyed) socket.destroy()
  }
  stream.on('end', destroy)
  stream.on('close', destroy)
  stream.on('error', destroy)

  const onAbort = () => {
    incoming.destroy(abortError())
    destroy()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  stream.on('close', () => signal?.removeEventListener('abort', onAbort))

  const noBody = status === 204 || status === 205 || status === 304
  if (noBody) incoming.resume()
  if (process.env.DSH_PROVIDER_TRANSPORT_DEBUG === '1') {
    const state = () => ({
      destroyed: incoming.destroyed,
      flowing: incoming.readableFlowing,
      length: incoming.readableLength,
      ended: incoming.readableEnded,
      socketDestroyed: socket.destroyed,
    })
    debugLog('body start', state())
    incoming.on('end', () => debugLog('body end', state()))
    incoming.on('close', () => debugLog('body close', state()))
    const timer = setInterval(() => debugLog('body state', state()), 1000)
    const stop = () => clearInterval(timer)
    incoming.on('end', stop)
    incoming.on('close', stop)
    incoming.on('error', (error) => {
      stop()
      debugLog('body error', error?.message)
    })
  }
  const body = noBody || incoming.destroyed ? null : Readable.toWeb(stream)
  const response = new Response(body, {
    status,
    statusText: incoming.statusMessage ?? '',
    headers,
  })
  return defineMeta(response, url, false)
}

function sendOverSocket({ socket, method, path, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      socket.destroy()
      reject(abortError())
      return
    }
    let request
    try {
      request = http.request({
        method,
        path,
        headers: headersOf(headers),
        setHost: false,
        createConnection: () => socket,
      })
    } catch (error) {
      socket.destroy()
      reject(error)
      return
    }
    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (handler, value) => {
      if (settled) return
      settled = true
      cleanup()
      handler(value)
    }
    const onAbort = () => {
      const error = abortError()
      request.destroy(error)
      socket.destroy(error)
      finish(reject, error)
    }
    // Keep listening after the response arrives: a later abort destroys the
    // request too, and an unhandled ClientRequest 'error' would crash the host.
    const onError = (error) => {
      if (settled) return
      socket.destroy()
      finish(reject, error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    request.once('error', onError)
    debugLog('request created', method, path.slice(0, 80))
    request.once('response', (incoming) => {
      debugLog('response', incoming.statusCode)
      if (settled) {
        incoming.resume()
        return
      }
      settled = true
      cleanup()
      resolve(buildResponse(incoming, socket, signal, undefined))
    })
    if (body !== undefined && body.length > 0) request.write(body)
    request.end()
  })
}

function redirectTarget(location, base) {
  try {
    return new URL(location, base)
  } catch {
    return undefined
  }
}

async function cancelResponse(response) {
  try {
    await response.body?.cancel()
  } catch {
    // The transport already dropped the socket.
  }
}

/** Send one normalized Request through the proxy and shape the reply as a Response. */
async function performRequest({ url, method, headers, body, proxy, signal, tlsOptions }) {
  const target = toTarget(url)
  const tunnel = await openTarget(target, proxy, signal, tlsOptions)
  const outgoing = new Headers(headers)
  if (!outgoing.has('host')) outgoing.set('host', url.host)
  if (!outgoing.has('accept')) outgoing.set('accept', '*/*')
  if (!outgoing.has('accept-encoding')) outgoing.set('accept-encoding', 'gzip, deflate, br')
  if (!outgoing.has('user-agent')) outgoing.set('user-agent', 'undici')
  outgoing.set('connection', 'close')
  outgoing.delete('content-length')
  if (body !== undefined) outgoing.set('content-length', String(body.length))
  else if (method !== 'GET' && method !== 'HEAD') outgoing.set('content-length', '0')
  if (tunnel.absoluteForm && tunnel.proxyAuthorization) {
    outgoing.set('proxy-authorization', tunnel.proxyAuthorization)
  }
  const path = tunnel.absoluteForm ? url.href : `${url.pathname}${url.search}` || '/'
  const response = await sendOverSocket({ socket: tunnel.socket, method, path, headers: outgoing, body, signal })
  return defineMeta(response, url.href, false)
}

/**
 * Fetch a URL through an HTTP(S) or SOCKS5 proxy, returning a standard Response.
 *
 * @param input - `Request`, URL string or `URL`, exactly as `fetch` accepts.
 * @param init - Standard request options; `headers` here override the request's.
 * @param options - `{ proxyUrl, tlsOptions? }`. `tlsOptions` is reserved for tests.
 * @returns A WHATWG `Response` with a streaming body.
 */
export async function fetchThroughProxy(input, init, options = {}) {
  const proxy = parseProxyUrl(options.proxyUrl)
  const request = new Request(input, init)
  const signal = request.signal
  throwIfAborted(signal)
  let url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`不支持的协议：${url.protocol}`)
  }
  let method = request.method
  let body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer())
  const headers = new Headers(request.headers)
  for (const name of HOP_BY_HOP) headers.delete(name)
  headers.delete('host')
  headers.delete('content-length')
  let redirected = false

  for (let hop = 0; ; hop += 1) {
    const response = await performRequest({
      url,
      method,
      headers,
      body,
      proxy,
      signal,
      tlsOptions: options.tlsOptions,
    })
    defineMeta(response, url.href, redirected)
    const location = response.headers.get('location')
    if (!REDIRECT_STATUS.has(response.status) || location === null) return response
    if (request.redirect === 'manual') return response
    if (request.redirect === 'error') {
      await cancelResponse(response)
      throw new TypeError('fetch 重定向被 redirect: "error" 拒绝')
    }
    if (hop >= MAX_REDIRECTS) {
      await cancelResponse(response)
      throw new TypeError('fetch 重定向次数过多')
    }
    const next = redirectTarget(location, url)
    if (next === undefined || (next.protocol !== 'http:' && next.protocol !== 'https:')) {
      await cancelResponse(response)
      throw new TypeError('fetch 重定向目标不是 HTTP(S) URL')
    }
    await cancelResponse(response)
    const status = response.status
    if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
      if (method !== 'HEAD') method = 'GET'
      body = undefined
      headers.delete('content-type')
      headers.delete('content-length')
    }
    if (next.origin !== url.origin) {
      headers.delete('authorization')
      headers.delete('cookie')
      headers.delete('proxy-authorization')
    }
    url = next
    redirected = true
  }
}
