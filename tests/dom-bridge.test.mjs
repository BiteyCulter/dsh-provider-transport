/** Headless harness for the client DOM bridge (plain Node, no browser). */
import { pathToFileURL } from 'node:url'

/* ------------------------- fake DOM ------------------------- */
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type
    this.bubbles = init.bubbles === true
    this.cancelable = init.cancelable !== false
    this.target = null
    this.currentTarget = null
    this.defaultPrevented = false
    this.stopped = false
    this.stoppedImmediate = false
  }
  preventDefault() {
    this.defaultPrevented = true
  }
  stopPropagation() {
    this.stopped = true
  }
  stopImmediatePropagation() {
    this.stopped = true
    this.stoppedImmediate = true
  }
}

let documentRef = null

class FakeText {
  constructor(text) {
    this.nodeType = 3
    this.textContent = String(text)
    this.parentNode = null
  }
  get isConnected() {
    let node = this
    while (node.parentNode) node = node.parentNode
    return node === documentRef
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
}

class FakeElement {
  constructor(tag, doc) {
    this.nodeType = 1
    this.tagName = String(tag).toUpperCase()
    this.ownerDocument = doc
    this.parentNode = null
    this.childNodes = []
    this.attributes = new Map()
    this.style = {}
    this.listeners = []
    this.value = ''
    this.disabled = false
    this._class = ''
  }
  get classList() {
    const tokens = this._class.split(/\s+/).filter(Boolean)
    const list = [...tokens]
    list.add = (token) => {
      if (!list.includes(token)) {
        list.push(token)
        this._class = list.filter((item) => typeof item === 'string').join(' ')
      }
    }
    list.remove = (token) => {
      const index = list.indexOf(token)
      if (index >= 0) {
        list.splice(index, 1)
        this._class = list.filter((item) => typeof item === 'string').join(' ')
      }
    }
    list.contains = (token) => list.includes(token)
    return list
  }
  setAttribute(name, value) {
    const key = String(name).toLowerCase()
    this.attributes.set(key, String(value))
    if (key === 'class') this._class = String(value)
    if (key === 'id') this.id = String(value)
    if (key === 'type') this.type = String(value)
  }
  getAttribute(name) {
    const key = String(name).toLowerCase()
    return this.attributes.has(key) ? this.attributes.get(key) : null
  }
  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase())
  }
  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase())
  }
  get id() {
    return this.getAttribute('id') ?? ''
  }
  set id(value) {
    this.attributes.set('id', String(value))
  }
  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1)
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null
  }
  get firstElementChild() {
    return this.children[0] ?? null
  }
  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null
  }
  get nextElementSibling() {
    if (!this.parentNode) return null
    const siblings = this.parentNode.children
    const index = siblings.indexOf(this)
    return siblings[index + 1] ?? null
  }
  get previousElementSibling() {
    if (!this.parentNode) return null
    const siblings = this.parentNode.children
    const index = siblings.indexOf(this)
    return index > 0 ? siblings[index - 1] : null
  }
  get textContent() {
    let text = ''
    for (const child of this.childNodes) {
      if (child.nodeType === 3) text += child.textContent
      else text += child.textContent
    }
    return text
  }
  set textContent(value) {
    this.childNodes = []
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(String(value)))
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }
  insertBefore(node, reference) {
    if (reference === null || reference === undefined) return this.appendChild(node)
    if (node.parentNode) node.parentNode.removeChild(node)
    const index = this.childNodes.indexOf(reference)
    node.parentNode = this
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node)
    return node
  }
  before(node) {
    if (!this.parentNode) return
    this.parentNode.insertBefore(node, this)
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) {
      this.childNodes.splice(index, 1)
      node.parentNode = null
    }
    return node
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChild(child)
    for (const node of nodes) this.appendChild(node)
  }
  contains(node) {
    let current = node
    while (current) {
      if (current === this) return true
      current = current.parentNode
    }
    return false
  }
  closest(selector) {
    let current = this
    while (current && current.nodeType === 1) {
      if (matches(current, selector)) return current
      current = current.parentNode
    }
    return null
  }
  querySelectorAll(selector) {
    const groups = selector.split(',').map((part) => part.trim())
    const out = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue
        if (groups.some((group) => matches(child, group))) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  getClientRects() {
    return [{ width: 100, height: 20 }]
  }
  get isConnected() {
    let node = this
    while (node.parentNode) node = node.parentNode
    return node === documentRef
  }
  addEventListener(type, handler, options) {
    const capture = options === true || (options && options.capture === true)
    this.listeners.push({ type, handler, capture })
  }
  removeEventListener(type, handler, options) {
    const capture = options === true || (options && options.capture === true)
    this.listeners = this.listeners.filter(
      (entry) => !(entry.type === type && entry.handler === handler && entry.capture === capture),
    )
  }
  dispatchEvent(event) {
    if (event.target === null) event.target = this
    const path = []
    let node = this
    while (node) {
      path.push(node)
      node = node.parentNode
    }
    const invoke = (target) => {
      for (const entry of [...target.listeners]) {
        if (entry.type !== event.type) continue
        if (target === this ? !entry.capture : entry.capture) continue
        if (event.stoppedImmediate) return
        event.currentTarget = target
        entry.handler.call(target, event)
      }
    }
    // capture: document -> ... -> parent
    const captureTargets = [...path].reverse().slice(1).reverse()
    for (const target of [...path].slice(1).reverse()) {
      if (event.stopped) break
      for (const entry of [...target.listeners]) {
        if (entry.type !== event.type || !entry.capture) continue
        event.currentTarget = target
        entry.handler.call(target, event)
        if (event.stopped) break
      }
    }
    // target phase
    for (const entry of [...this.listeners]) {
      if (entry.type !== event.type || event.stopped) continue
      event.currentTarget = this
      entry.handler.call(this, event)
    }
    // bubble: parent -> document
    if (event.bubbles) for (const target of path.slice(1)) {
      if (event.stopped) break
      for (const entry of [...target.listeners]) {
        if (entry.type !== event.type || entry.capture) continue
        event.currentTarget = target
        entry.handler.call(target, event)
        if (event.stopped) break
      }
    }
    return !event.defaultPrevented
  }
  click() {
    this.dispatchEvent(new FakeEvent('click', { bubbles: true }))
  }
}

function matches(element, selector) {
  if (!selector) return false
  if (selector === '*') return true
  const match = /^([a-zA-Z0-9-]+)?((?:\[[^\]]+\])*)$/.exec(selector)
  if (!match) return false
  const [, tag, attributes] = match
  if (tag && element.tagName !== tag.toUpperCase()) return false
  if (!attributes) return true
  for (const attribute of attributes.matchAll(/\[([a-zA-Z0-9_-]+)(?:([*$^]?=)"?([^"\]]*)"?)?\]/g)) {
    const [, name, operator, value] = attribute
    const actual = element.getAttribute(name)
    if (actual === null) return false
    if (operator === '=' && actual !== value) return false
    if (operator === '*=' && !actual.includes(value)) return false
    if (operator === '$=' && !actual.endsWith(value)) return false
    if (operator === '^=' && !actual.startsWith(value)) return false
  }
  return true
}

class FakeDocument extends FakeElement {
  constructor() {
    super('#document', null)
    this.ownerDocument = this
    documentRef = this
    this.body = new FakeElement('body', this)
    this.body.parentNode = this
    this.childNodes.push(this.body)
  }
  createElement(tag) {
    return new FakeElement(tag, this)
  }
  createTextNode(text) {
    return new FakeText(text)
  }
}

const observers = new Set()
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.target = null
  }
  observe(target) {
    this.target = target
    observers.add(this)
  }
  disconnect() {
    observers.delete(this)
  }
  takeRecords() {
    return []
  }
}
function flushMutations() {
  for (const observer of [...observers]) observer.callback([], observer)
}

globalThis.MutationObserver = FakeMutationObserver
globalThis.__flushMutations = flushMutations
const document = new FakeDocument()
globalThis.document = document

/* ------------------------- load the bundle ------------------------- */
let bundle
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      bundle = spec
    },
  },
}
const clientUrl = process.argv[2] === undefined ? new URL('../client.js', import.meta.url) : pathToFileURL(process.argv[2])
await import(`${clientUrl.href}?run=${Date.now()}`)
if (!bundle) throw new Error('client bundle did not register')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
}
const slots = []
const mutates = []
const effectDisposers = []
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
}
const api = bundle.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require ${name}`)
})
const ctx = {
  effect(callback) {
    const dispose = callback()
    effectDisposers.push(() => {
      if (typeof dispose === 'function') dispose()
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  on() {
    return () => {}
  },
  locale: {
    register() {
      return () => {}
    },
    bind() {
      return (key, params) => {
        if (params) {
          return String(key).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        }
        return String(key)
      }
    },
  },
  slots: {
    inject(name, callback) {
      callback()
    },
    register(spec, component) {
      slots.push({ spec, component })
      return () => {}
    },
  },
  remote: {
    settings: {
      async describe() {
        return {
          ok: true,
          value: {
            namespaces: [
              { ns: 'provider-transport', revision: 1, value: { providers: {} } },
              { ns: 'llm-deepseek', revision: 1, value: {} },
            ],
          },
        }
      },
      async mutate(ns, ops, revision) {
        mutates.push({ ns, ops, revision, stack: new Error('mutate').stack })
        const providers = {}
        for (const op of ops ?? []) if (op.op === 'set') providers[op.path[op.path.length - 1]] = op.value
        return { ok: true, value: { revision: (revision ?? 0) + 1, value: { providers } } }
      },
    },
  },
}
api.apply(ctx)
const disposers = []
check('three seats registered', slots.length === 3, slots.map((entry) => entry.spec.key))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeAnchor(providerId, provider) {
  const span = document.createElement('span')
  span.setAttribute('data-dsh-transport-anchor', providerId)
  span.setAttribute('data-provider', providerId)
  span.__dshTransportProvider = provider
  return span
}
function makeEditor({ footerLabels = ['取消', '保存'], route = false, classNames = ['zGbnIq_editor'] } = {}) {
  const card = document.createElement('div')
  card.setAttribute('class', classNames.join(' '))
  if (route) {
    const routeInput = document.createElement('input')
    routeInput.setAttribute('type', 'text')
    card.appendChild(routeInput)
  }
  const field = document.createElement('input')
  field.setAttribute('type', 'password')
  card.appendChild(field)
  const footer = document.createElement('div')
  footer.setAttribute('class', 'zGbnIq_editorActions')
  const buttons = footerLabels.map((label) => {
    const node = document.createElement('button')
    node.textContent = label
    footer.appendChild(node)
    return node
  })
  card.appendChild(footer)
  return { card, footer, buttons }
}

const row = document.createElement('li')
document.body.appendChild(row)
const provider = { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }
const anchor = makeAnchor('deepseek-official', provider)
row.appendChild(anchor)
const editor = makeEditor()
row.appendChild(editor.card)
let nativeSaves = 0
editor.buttons[1].addEventListener('click', () => {
  nativeSaves += 1
})
flushMutations()
await sleep(30)
await sleep(30)
const container = editor.card.querySelector('[data-dsh-transport-ui]')
check('fields injected', container !== null)
if (!(container !== null && container.nextElementSibling === editor.footer)) {
  check('DOM dump', false, {
    containerNext: container?.nextElementSibling?.getAttribute?.('class') ?? String(container?.nextElementSibling),
    cardChildren: editor.card.childNodes.map((node) => `${node.nodeType}:${node.tagName ?? 'text'}:${(node.getAttribute?.('class') ?? '')}:${(node.getAttribute?.('data-dsh-transport-ui') ?? '')}`),
  })
}
check('fields before footer', container !== null && container.nextElementSibling === editor.footer)
check('fields title', (container?.textContent ?? '').includes('title'))
check('proxy control', container !== null && container.querySelector('select') !== null)

editor.buttons[1].click()
await sleep(20)
check('untouched save passes through', nativeSaves === 1, nativeSaves)
check('untouched save writes nothing', mutates.length === 0)

// Configure provider proxy through the injected controls.
const proxySelect = editor.card.querySelector('[data-dsh-transport-ui]').querySelectorAll('select')[0]
proxySelect.value = 'proxy'
proxySelect.dispatchEvent(new FakeEvent('change', { bubbles: true }))
await sleep(10)
const urlInput = editor.card.querySelector('[data-dsh-transport-ui]').querySelectorAll('input').find((input) => input.getAttribute('aria-label') === 'url')
check('proxy url input appears', urlInput !== undefined)
urlInput.value = 'http://127.0.0.1:1080'
urlInput.dispatchEvent(new FakeEvent('input', { bubbles: true }))
editor.buttons[1].click()
await sleep(80)
check('shared save writes transport', mutates.length === 1, mutates)
check(
  'shared save targets the provider',
  mutates[0]?.ops?.[0]?.op === 'set' && mutates[0]?.ops?.[0]?.path?.join('.') === 'providers.deepseek-official',
  mutates[0],
)
check('native save replayed', nativeSaves === 2, nativeSaves)

// Custom creation card: no anchor, provider id read from the route input.
const panel = document.createElement('div')
panel.setAttribute('id', 'settings-models-add-custom-panel')
const custom = makeEditor({ route: true })
panel.appendChild(custom.card)
document.body.appendChild(panel)
mutates.length = 0
nativeSaves = 0
custom.buttons[1].addEventListener('click', () => {
  nativeSaves += 1
})
flushMutations()
await sleep(40)
const customContainer = custom.card.querySelector('[data-dsh-transport-ui]')
check('custom create gets fields', customContainer !== null)
const routeInput = custom.card.querySelector('input[type="text"]')
routeInput.value = 'acme-gateway'
routeInput.dispatchEvent(new FakeEvent('input', { bubbles: true }))
const customSelect = custom.card.querySelector('[data-dsh-transport-ui]').querySelectorAll('select')[0]
customSelect.value = 'proxy'
customSelect.dispatchEvent(new FakeEvent('change', { bubbles: true }))
await sleep(10)
const customUrl = custom.card.querySelector('[data-dsh-transport-ui]').querySelectorAll('input').find((input) => input.getAttribute('aria-label') === 'url')
customUrl.value = 'socks5h://127.0.0.1:1080'
customUrl.dispatchEvent(new FakeEvent('input', { bubbles: true }))
custom.buttons[1].click()
await sleep(80)
check('custom create writes typed route', mutates[0]?.ops?.[0]?.path?.join('.') === 'providers.acme-gateway', mutates[0])
check('custom create replays native save', nativeSaves === 1, nativeSaves)

// Incomplete card must stay untouched.
const broken = makeEditor({ footerLabels: ['保存'] })
document.body.appendChild(broken.card)
flushMutations()
await sleep(30)
check('incomplete card ignored', broken.card.querySelector('[data-dsh-transport-ui]') === null)

// Fallback: an open editor with a header route but no adjacent anchor.
const fallback = makeEditor()
const header = document.createElement('div')
header.setAttribute('class', 'zGbnIq_editorHeader')
const routeSpan = document.createElement('span')
routeSpan.setAttribute('class', 'zGbnIq_editorRoute')
routeSpan.textContent = 'kimi-coding'
header.appendChild(routeSpan)
fallback.card.insertBefore(header, fallback.card.firstElementChild)
document.body.appendChild(fallback.card)
flushMutations()
await sleep(40)
check('card without anchor or panel is ignored', fallback.card.querySelector('[data-dsh-transport-ui]') === null)
check(
  'debug counters available',
  globalThis.__dshProviderTransport !== undefined && globalThis.__dshProviderTransport.anchors >= 1,
  globalThis.__dshProviderTransport,
)
check('debug anchor sample recorded', globalThis.__dshProviderTransport.sample !== null, globalThis.__dshProviderTransport.sample)

// Anchor wrapped one level deeper than the editor card (slot wrapper tolerance).
const wrappedRow = document.createElement('li')
document.body.appendChild(wrappedRow)
const wrapper = document.createElement('div')
const wrappedAnchor = makeAnchor('kimi-coding', { provider: 'kimi-coding', settingsNs: 'llm-pi-ai', settingsPath: [] })
wrapper.appendChild(wrappedAnchor)
wrappedRow.appendChild(wrapper)
const wrappedEditor = makeEditor({ classNames: [] })
wrappedRow.appendChild(wrappedEditor.card)
flushMutations()
await sleep(40)
check('wrapped anchor still finds editor', wrappedEditor.card.querySelector('[data-dsh-transport-ui]') !== null)

// Classless editor card: detection must not depend on CSS-module names.
const plainRow = document.createElement('li')
document.body.appendChild(plainRow)
const plainAnchor = makeAnchor('other-provider', { provider: 'other-provider', settingsNs: 'llm-pi-ai', settingsPath: [] })
plainRow.appendChild(plainAnchor)
const classlessEditor = makeEditor({ classNames: [] })
plainRow.appendChild(classlessEditor.card)
flushMutations()
await sleep(40)
check('classless editor card detected', classlessEditor.card.querySelector('[data-dsh-transport-ui]') !== null)

for (const dispose of effectDisposers) dispose()

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}`)
if (failed.length > 0) console.log(JSON.stringify({ failed, mutates }, null, 2))
console.log(`dom bridge: ${results.length - failed.length}/${results.length} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
