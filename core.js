/**
 * Pure, provider-neutral route and header resolution.
 *
 * Everything here is framework-free so the host plugin, the browser editor and
 * the tests share one authority for "which proxy / which headers apply".
 */

/** RFC 7230 token characters. */
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Headers the native adapter (or the HTTP client) owns. Overriding any of them
 * would corrupt authentication, framing or connection reuse, so the editor
 * rejects them before they are ever persisted.
 */
export const RESERVED_HEADERS = Object.freeze([
  'authorization',
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
])

const RESERVED = new Set(RESERVED_HEADERS)
const MACRO = /\$\{(sessionId|provider|model|purpose)\}/g
const UNKNOWN_MACRO = /\$\{[^}]*\}/

/** Dynamic values a header template may interpolate. */
export const MACROS = Object.freeze(['sessionId', 'provider', 'model', 'purpose'])

/** Proxy modes accepted by the editor; `inherit` defers to the enclosing scope. */
export const PROXY_MODES = Object.freeze(['inherit', 'direct', 'proxy'])

/** Proxy URL schemes the built-in transport implements. */
export const PROXY_PROTOCOLS = Object.freeze(['http:', 'https:', 'socks5:', 'socks5h:'])

export function validateProxy(entry) {
  if (entry === undefined || entry === null) return
  if (typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Proxy 配置必须是对象')
  // Schemastery materializes an omitted proxy as `{}`; an absent mode means inherit.
  if (entry.mode === undefined || entry.mode === null || entry.mode === '') return
  if (!PROXY_MODES.includes(entry.mode)) throw new Error('Proxy 模式必须是 inherit/direct/proxy')
  if (entry.mode !== 'proxy') return
  if (typeof entry.url !== 'string' || entry.url.length === 0) throw new Error('Proxy 地址不能为空')
  let parsed
  try {
    parsed = new URL(entry.url)
  } catch {
    throw new Error('Proxy 地址不是有效 URL')
  }
  if (!PROXY_PROTOCOLS.includes(parsed.protocol)) throw new Error('仅支持 http/https/socks5/socks5h 代理')
  if (!parsed.hostname) throw new Error('Proxy 缺少主机')
}

export function validateHeaders(headers) {
  if (headers === undefined) return
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('Headers 必须是键值对象')
  }
  const seen = new Set()
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw new Error(`Header 名称无效：${name}`)
    const key = name.toLowerCase()
    if (RESERVED.has(key)) throw new Error(`Header ${name} 由 DSH 管理，不能覆盖`)
    if (seen.has(key)) throw new Error(`Header 重复：${name}`)
    seen.add(key)
    if (typeof value !== 'string') throw new Error(`Header ${name} 的值必须是字符串`)
    if (/[\r\n]/.test(value)) throw new Error(`Header ${name} 的值不能包含换行`)
    if (UNKNOWN_MACRO.test(value.replace(MACRO, ''))) throw new Error(`Header ${name} 含不支持的宏`)
  }
}

export function validateModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('Model 配置必须是对象')
  validateProxy(model.proxy)
  validateHeaders(model.headers)
  if (model.removeHeaders !== undefined) {
    if (
      !Array.isArray(model.removeHeaders) ||
      !model.removeHeaders.every((name) => typeof name === 'string' && HEADER_NAME.test(name))
    ) {
      throw new Error('removeHeaders 必须是 Header 名称数组')
    }
  }
}

export function validateProvider(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Provider 配置必须是对象')
  validateProxy(profile.proxy)
  validateHeaders(profile.headers)
  if (profile.models === undefined) return
  if (!profile.models || typeof profile.models !== 'object' || Array.isArray(profile.models)) {
    throw new Error('Models 配置无效')
  }
  for (const [id, model] of Object.entries(profile.models)) {
    if (!id.trim()) throw new Error('Model ID 不能为空')
    validateModel(model)
  }
}

/** Provider defaults, then model opt-outs, then model overrides; case-insensitive header identity. */
export function mergedHeaders(provider, model) {
  const result = new Map()
  for (const [name, value] of Object.entries(provider?.headers ?? {})) {
    result.set(name.toLowerCase(), [name, value])
  }
  for (const name of model?.removeHeaders ?? []) result.delete(name.toLowerCase())
  for (const [name, value] of Object.entries(model?.headers ?? {})) {
    result.set(name.toLowerCase(), [name, value])
  }
  return Object.fromEntries(result.values())
}

/**
 * Effective proxy/header route for one exact (provider, model) pair.
 *
 * @param providers - The `providers` section of the plugin configuration.
 * @param providerId - Native provider id, verbatim.
 * @param modelId - Native model id, verbatim.
 * @returns `{ proxyMode, proxyUrl, headers }`; `proxyUrl` is undefined unless a proxy is selected.
 */
export function resolveRoute(providers, providerId, modelId) {
  const provider = providers?.[providerId] ?? {}
  const model = provider.models?.[modelId] ?? {}
  const selected = model.proxy?.mode && model.proxy.mode !== 'inherit' ? model.proxy : provider.proxy
  return {
    proxyUrl: selected?.mode === 'proxy' ? selected.url : undefined,
    proxyMode: selected?.mode ?? 'inherit',
    headers: mergedHeaders(provider, model),
  }
}

/**
 * Expand header templates against one request context.
 *
 * A header whose template references a dynamic value that is missing for this
 * request is omitted entirely: sending a literal `${sessionId}` or an empty
 * credential header would be worse than not sending it.
 */
export function resolveHeaderValues(templates, context) {
  const result = {}
  for (const [name, raw] of Object.entries(templates ?? {})) {
    let missing = false
    const value = raw.replace(MACRO, (_, key) => {
      const actual = context?.[key]
      if (actual === undefined || actual === null || actual === '') {
        missing = true
        return ''
      }
      return String(actual)
    })
    if (!missing) result[name] = value
  }
  return result
}

/** Merge resolved templates over an existing header bag, keeping the bag's other members. */
export function applyHeaders(base, templates, context) {
  const headers = new Headers(base)
  for (const [name, value] of Object.entries(resolveHeaderValues(templates, context))) {
    headers.set(name, value)
  }
  return headers
}

/** True when a provider section carries no user override at all. */
export function configIsEmpty(profile) {
  if (!profile) return true
  if (profile.proxy?.mode && profile.proxy.mode !== 'inherit') return false
  if (Object.keys(profile.headers ?? {}).length) return false
  return Object.keys(profile.models ?? {}).length === 0
}

/** True when one model override can be deleted without losing an explicit choice. */
export function modelIsEmpty(model) {
  return (
    !(model?.proxy?.mode && model.proxy.mode !== 'inherit') &&
    !Object.keys(model?.headers ?? {}).length &&
    !(model?.removeHeaders ?? []).length
  )
}
