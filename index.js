/**
 * Host entry: activate per-provider transport only for the exact model request
 * that configured it, on the exact endpoint that adapter is about to call.
 */
import z from '@deepseek-ai/schemastery'
import { AsyncLocalStorage } from 'node:async_hooks'
import { applyHeaders, resolveRoute, validateProvider } from './core.js'
import { fetchThroughProxy } from './transport.js'

const ProxySchema = z.object({ mode: z.string(), url: z.string() })
const ModelSchema = z.object({
  proxy: ProxySchema,
  headers: z.dict(z.string()),
  removeHeaders: z.array(z.string()),
})
const ProviderSchema = z.object({
  proxy: ProxySchema,
  headers: z.dict(z.string()),
  models: z.dict(ModelSchema),
})

/**
 * Live provider overrides. Every field is `volatile()` so a settings write
 * reaches the running fiber without reloading the plugin.
 */
export const Config = z.object({
  providers: z.dict(ProviderSchema).default({}).volatile(),
})

export const name = 'dsh-provider-transport'
export const inject = []

/**
 * First-party adapters that send their requests through `globalThis.fetch`
 * without the pi-ai header waterfall. They never talk to a foreign origin from
 * inside one model request, so the whole scoped request is routed.
 */
const WHOLE_SCOPE_PROVIDERS = new Set(['deepseek-official', 'deepseek-account'])

/** Per model-request transport scope; survives async-generator pulls. */
const scope = new AsyncLocalStorage()

function scopeStream(next, state) {
  const iterator = scope.run(state, () => next()[Symbol.asyncIterator]())
  const stream = {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      return scope.run(state, () => iterator.next())
    },
  }
  if (typeof iterator.return === 'function') {
    stream.return = (value) => scope.run(state, () => iterator.return(value))
  }
  if (typeof iterator.throw === 'function') {
    stream.throw = (error) => scope.run(state, () => iterator.throw(error))
  }
  return stream
}

function readProviders(configuration) {
  const value = configuration?.providers
  if (value === undefined || value === null) return {}
  const plain = typeof value.get === 'function' ? value.get() : value
  return plain ?? {}
}

function urlOf(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (input !== null && typeof input === 'object' && typeof input.url === 'string') return new URL(input.url)
    return undefined
  } catch {
    return undefined
  }
}

function baseHeaders(input, init) {
  const headers = new Headers()
  if (typeof Request !== 'undefined' && input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value))
  }
  const extra = init?.headers
  if (extra !== undefined) new Headers(extra).forEach((value, key) => headers.set(key, value))
  return headers
}

/** Replace `globalThis.fetch` for the lifetime of the plugin. */
function maskProxy(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl)
    if (parsed.username || parsed.password) {
      parsed.username = '***'
      parsed.password = ''
    }
    return parsed.href
  } catch {
    return String(proxyUrl)
  }
}

function installFetchWrapper(logger) {
  const original = globalThis.fetch
  const wrapped = function (input, init) {
    const state = scope.getStore()
    if (state === undefined) return original.call(this, input, init)
    const url = urlOf(input)
    if (url === undefined) return original.call(this, input, init)
    if (!state.wholeScope && (state.origin === undefined || url.origin !== state.origin)) {
      return original.call(this, input, init)
    }
    const headers = applyHeaders(baseHeaders(input, init), state.headers, state)
    const nextInit = { ...(init ?? {}), headers }
    if (state.proxyUrl === undefined) return original.call(this, input, nextInit)
    return fetchThroughProxy(input, nextInit, { proxyUrl: state.proxyUrl }).catch((error) => {
      if (error?.name === 'AbortError') throw error
      const message = error?.message ?? '代理请求失败'
      // The provider adapter normalizes fetch failures into a generic transport
      // error, so keep the actionable cause in the host log.
      try {
        logger?.warn?.(
          `provider-transport: provider=${state.provider} model=${state.model} proxy=${maskProxy(state.proxyUrl)} request=${url.href} failed: ${message}`,
        )
      } catch {
        // Logging must never mask the transport failure.
      }
      throw new TypeError(`provider-transport: ${message}`, { cause: error })
    })
  }
  globalThis.fetch = wrapped
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original
  }
}

export function apply(ctx, configuration) {
  const read = () => readProviders(configuration)

  /** Resolve the route once per stream, failing loudly on an invalid saved config. */
  function routeFor(provider, model) {
    const profile = read()[provider]
    if (profile === undefined) return undefined
    validateProvider(profile)
    const route = resolveRoute({ [provider]: profile }, provider, model)
    if (route.proxyUrl === undefined && Object.keys(route.headers).length === 0) return undefined
    return route
  }

  const logger = ctx.logger
  ctx.effect(() => installFetchWrapper(logger), 'provider-transport: scoped fetch transport')

  // Outermost listener: wrap the adapter stream so both the proxy dispatcher and
  // the header macros stay in scope for every pull of the stream.
  ctx.on(
    'llm/stream',
    (options, next) => {
      const provider = options?.provider
      const model = options?.model
      if (typeof provider !== 'string' || typeof model !== 'string') return next()
      let route
      try {
        route = routeFor(provider, model)
      } catch (error) {
        try {
          logger?.warn?.(`provider-transport: invalid config for provider=${provider}: ${error?.message ?? error}`)
        } catch {
          // Logging must never mask the configuration failure.
        }
        throw new Error(`provider-transport: ${error?.message ?? error}`, { cause: error })
      }
      if (route === undefined) return next()
      return scopeStream(next, {
        provider,
        model,
        sessionId: options.sessionId,
        purpose: options.purpose,
        headers: route.headers,
        proxyUrl: route.proxyUrl,
        origin: undefined,
        wholeScope: WHOLE_SCOPE_PROVIDERS.has(provider),
      })
    },
    { global: true, prepend: true },
  )

  // The pi-ai adapter exposes the exact endpoint origin before any request I/O.
  // Learning it here keeps the scoped wrapper from touching unrelated fetches.
  ctx.on(
    'llm-pi-ai/request-headers',
    (request, headers, next) => {
      const provider = request?.provider
      if (typeof provider !== 'string') return next()
      const state = scope.getStore()
      if (state !== undefined && state.provider === provider) {
        const origin = originOf(request.baseURL)
        if (origin !== undefined) state.origin = origin
      }
      const profile = read()[provider]
      if (profile === undefined) return next()
      let route
      try {
        validateProvider(profile)
        route = resolveRoute({ [provider]: profile }, provider, request.model)
      } catch (error) {
        throw new Error(`provider-transport: ${error?.message ?? error}`, { cause: error })
      }
      if (Object.keys(route.headers).length === 0) return next()
      const expanded = applyHeaders(headers, route.headers, {
        sessionId: request.sessionId,
        provider,
        model: request.model,
        purpose: request.purpose,
      })
      // The event owns one mutable Headers object; keep the same reference.
      expanded.forEach((value, key) => {
        if (!headers.has(key) || headers.get(key) !== value) headers.set(key, value)
      })
      return next()
    },
    { global: true },
  )
}

function originOf(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.length === 0) return undefined
  try {
    const url = new URL(baseURL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}
