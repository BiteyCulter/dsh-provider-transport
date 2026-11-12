/** Loopback test servers: HTTP target, HTTP(S) forward proxy, SOCKS5 proxy. */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import dns from 'node:dns/promises'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

/** Buffered reader shared by the test SOCKS server handshake. */
export function createReader(socket) {
  let buffer = Buffer.alloc(0)
  let pending
  let failure
  const wake = () => {
    const notify = pending
    if (notify === undefined) return
    pending = undefined
    notify()
  }
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    wake()
  }
  const onError = (error) => {
    failure ??= error
    wake()
  }
  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', () => {
    failure ??= new Error('socket closed during handshake')
    wake()
  })
  return {
    async read(length) {
      while (buffer.length < length) {
        if (failure) throw failure
        await new Promise((resolve) => {
          pending = resolve
        })
      }
      const out = buffer.subarray(0, length)
      buffer = buffer.subarray(length)
      return out
    },
    release() {
      socket.off('data', onData)
      socket.off('error', onError)
      const rest = buffer
      buffer = Buffer.alloc(0)
      return rest
    },
  }
}

/**
 * HTTP target server recording every request.
 *
 * Routes: `/` JSON echo, `/stream` chunked SSE, `/gzip` gzip JSON, `/redirect`
 * 302 to `/`, `/slow` delayed end, `/nocontent` 204.
 */
export async function startTargetServer() {
  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const entry = { method: request.method, url: request.url, headers: request.headers, body }
      requests.push(entry)
      if (request.url === '/stream') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.write('event: start\n\n')
        let count = 0
        const timer = setInterval(() => {
          count += 1
          response.write(`data: ${count}\n\n`)
          if (count >= 3) {
            clearInterval(timer)
            response.end('data: done\n\n')
          }
        }, 25)
        response.on('close', () => clearInterval(timer))
        return
      }
      if (request.url === '/gzip') {
        const payload = JSON.stringify({ ok: true, method: 'gzip' })
        const encoded = zlib.gzipSync(Buffer.from(payload))
        response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
        response.end(encoded)
        return
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/' })
        response.end('redirecting')
        return
      }
      if (request.url === '/slow') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        const timer = setTimeout(() => {
          response.write('slow')
          response.end(' done')
        }, 400)
        response.on('close', () => clearTimeout(timer))
        return
      }
      if (request.url === '/nocontent') {
        response.writeHead(204)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] })
      response.end(JSON.stringify(entry))
    })
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** HTTPS variant of the target server; requires a key/cert pair. */
export async function startHttpsTargetServer({ key, cert }) {
  const requests = []
  const server = https.createServer({ key, cert }, (request, response) => {
    requests.push({ url: request.url, headers: request.headers })
    if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: first\n\n')
      const timer = setTimeout(() => response.end('data: done\n\n'), 40)
      response.on('close', () => clearTimeout(timer))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ secure: true, url: request.url }))
  })
  const port = await listen(server)
  return {
    url: `https://localhost:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * HTTP forward proxy: absolute-form requests plus CONNECT tunnels.
 * Records every proxied request and CONNECT authority it observes.
 */
export async function startHttpProxy({ auth, tls } = {}) {
  const proxied = []
  const tunnels = []
  const expected = auth === undefined ? undefined : `Basic ${Buffer.from(auth).toString('base64')}`
  const server = tls === undefined ? http.createServer() : http.createServer(tls)

  server.on('request', (request, response) => {
    const observed = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      proxyAuthorization: request.headers['proxy-authorization'],
    }
    proxied.push(observed)
    if (expected !== undefined && observed.proxyAuthorization !== expected) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' })
      response.end('proxy authentication required')
      return
    }
    let target
    try {
      target = new URL(request.url)
    } catch {
      response.writeHead(400)
      response.end('absolute-form URL required')
      return
    }
    const headers = { ...request.headers }
    for (const name of ['proxy-authorization', 'proxy-connection', 'connection']) delete headers[name]
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstream.on('error', () => {
      response.writeHead(502)
      response.end('upstream failed')
    })
    request.pipe(upstream)
  })

  server.on('connect', (request, clientSocket, head) => {
    const observed = { authority: request.url, headers: request.headers }
    tunnels.push(observed)
    if (expected !== undefined && request.headers['proxy-authorization'] !== expected) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      clientSocket.destroy()
      return
    }
    const index = request.url.lastIndexOf(':')
    const host = request.url.slice(0, index)
    const port = Number(request.url.slice(index + 1))
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    proxied,
    tunnels,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Minimal SOCKS5 server: no-auth or username/password, CONNECT only. */
export async function startSocksProxy({ username, password } = {}) {
  const connections = []
  const expectAuth = username !== undefined
  const server = net.createServer((socket) => {
    void (async () => {
      const reader = createReader(socket)
      try {
        const greeting = await reader.read(2)
        const methods = await reader.read(greeting[1])
        const offered = [...methods]
        let chosen = 0x00
        if (expectAuth) {
          if (!offered.includes(0x02)) {
            socket.destroy()
            return
          }
          chosen = 0x02
        } else if (!offered.includes(0x00)) {
          socket.destroy()
          return
        }
        socket.write(Buffer.from([0x05, chosen]))
        if (chosen === 0x02) {
          const [version, userLength] = await reader.read(2)
          const user = (await reader.read(userLength)).toString('utf8')
          const passwordLength = (await reader.read(1))[0]
          const pass = (await reader.read(passwordLength)).toString('utf8')
          const ok = version === 0x01 && user === username && pass === password
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
          if (!ok) {
            socket.destroy()
            return
          }
        }
        const head = await reader.read(4)
        const atyp = head[3]
        let host
        let addressType = atyp
        if (atyp === 0x01) {
          host = [...(await reader.read(4))].join('.')
        } else if (atyp === 0x04) {
          host = 'ipv6'
          await reader.read(16)
        } else if (atyp === 0x03) {
          const length = (await reader.read(1))[0]
          host = (await reader.read(length)).toString('ascii')
        } else {
          socket.destroy()
          return
        }
        const portBytes = await reader.read(2)
        const port = (portBytes[0] << 8) | portBytes[1]
        connections.push({ host, port, atyp: addressType })
        const rest = reader.release()
        const connectHost = atyp === 0x03 ? (await dns.lookup(host)).address : host
        const upstream = net.connect(port, connectHost, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          if (rest.length > 0) upstream.write(rest)
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
        upstream.on('error', () => {
          try {
            socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          } catch {}
          socket.destroy()
        })
        socket.on('error', () => upstream.destroy())
      } catch {
        socket.destroy()
      }
    })()
  })
  const port = await listen(server)
  const scheme = expectAuth
    ? `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}`
    : `socks5://127.0.0.1:${port}`
  return {
    url: scheme,
    port,
    connections,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
