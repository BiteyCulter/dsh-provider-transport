/**
 * DSH Web client entry.
 *
 * The native provider editor (create + edit) has no plugin slot, so this bundle
 * mounts its fields *inside* the native editor card and shares the native
 * Save/Cancel flow: a capture-phase click on the native submit button saves the
 * transport namespace first and then lets the native save run; Cancel discards
 * the transport draft together with the native one.
 *
 * The injected form is plain DOM so it stays independent of the renderer that
 * owns the surrounding card. The only React in this bundle is the hidden anchor
 * component registered in the provider-card slot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-provider-transport',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'provider-transport'
    const COPY = 'dsh.providerTransport'
    const SEATS = ['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account']
    const DYNAMIC = '__dynamic__'
    const RESERVED = [
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
    ]
    const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
    const MACRO = /\$\{(sessionId|provider|model|purpose)\}/g
    const PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:']
    const MACROS_HINT = '${sessionId} · ${provider} · ${model} · ${purpose}'

    const translations = {
      zh: {
        title: '网络代理与请求头',
        subtitle: '随本表单一起保存；只影响该 Provider 的模型请求。',
        proxy: 'Proxy 传输',
        inherit: '继承 DSH 默认',
        modelInherit: '继承 Provider',
        direct: '不使用代理',
        via: '指定代理',
        url: 'Proxy 地址（http / https / socks5 / socks5h）',
        urlHint: '例：socks5h://127.0.0.1:1080、http://user:pass@proxy:8080',
        headers: '自定义请求头',
        name: '名称',
        value: '值或宏',
        add: '添加请求头',
        removeRow: '删除这一行',
        modelOverrides: '按 Model 覆盖（可选）',
        modelPick: '选择 Model',
        removeInherited: '排除继承的请求头（逗号分隔）',
        resetModel: '移除该 Model 覆盖',
        loading: '正在读取传输配置…',
        conflict: '设置已被其他窗口修改，请重新加载后再保存',
        unsupported: 'provider-transport 设置命名空间不可用：插件尚未被 DSH 加载，请重启 DSH 后刷新页面',
        loadFailed: '读取传输配置失败',
        retry: '重新加载',
        saved: '传输配置已保存',
        macros: `宏：${MACROS_HINT}；缺少动态值的请求头不会发送。`,
        dynamicHint: '该配置将随创建一起保存到上面填写的 Provider ID。',
        reserved: '请求头 {name} 由 DSH 管理，不能覆盖',
        badName: '请求头名称无效',
        duplicate: '请求头重复：{name}',
        badValue: '请求头包含非法字符',
        unknownMacro: '请求头 {name} 含不支持的宏',
        badProxy: 'Proxy 地址无效，应以 http://、https://、socks5:// 或 socks5h:// 开头',
        badRemove: '排除项必须是合法的请求头名称',
        emptyName: '请求头名称不能为空（或整行留空）',
      },
      en: {
        title: 'Proxy & Request Headers',
        subtitle: 'Saved with this form; affects only this provider’s model requests.',
        proxy: 'Proxy transport',
        inherit: 'Inherit DSH default',
        modelInherit: 'Inherit Provider',
        direct: 'No proxy',
        via: 'Custom proxy',
        url: 'Proxy URL (http / https / socks5 / socks5h)',
        urlHint: 'e.g. socks5h://127.0.0.1:1080, http://user:pass@proxy:8080',
        headers: 'Custom headers',
        name: 'Name',
        value: 'Value or macro',
        add: 'Add header',
        removeRow: 'Remove this row',
        modelOverrides: 'Per-model overrides (optional)',
        modelPick: 'Choose a model',
        removeInherited: 'Exclude inherited headers (comma-separated)',
        resetModel: 'Remove this model override',
        loading: 'Loading transport settings…',
        conflict: 'Settings changed elsewhere; reload before saving again',
        unsupported: 'The provider-transport settings namespace is unavailable: DSH has not loaded the plugin yet; restart DSH and refresh this page',
        loadFailed: 'Failed to load transport settings',
        retry: 'Reload',
        saved: 'Transport settings saved',
        macros: `Macros: ${MACROS_HINT}. A header with a missing dynamic value is not sent.`,
        dynamicHint: 'Saved together with the provider being created, under the Provider ID typed above.',
        reserved: 'Header {name} is managed by DSH and cannot be overridden',
        badName: 'Invalid header name',
        duplicate: 'Duplicate header: {name}',
        badValue: 'Header value contains illegal characters',
        unknownMacro: 'Header {name} contains an unsupported macro',
        badProxy: 'Invalid proxy URL; it must start with http://, https://, socks5:// or socks5h://',
        badRemove: 'Excluded entries must be valid header names',
        emptyName: 'A header needs a name (or leave the whole row empty)',
      },
    }

    const styles = {
      block: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        paddingTop: '14px',
        borderTop: '1px solid var(--dsw-alias-border-l2)',
      },
      section: { display: 'flex', flexDirection: 'column', gap: '6px' },
      head: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '18px' },
      fieldLabel: { fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: '32px',
        padding: '0 10px',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      select: { maxWidth: '240px', cursor: 'pointer' },
      row: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      rowInput: { flex: '1 1 150px', minWidth: '0' },
      button: {
        boxSizing: 'border-box',
        height: '28px',
        padding: '0 10px',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        border: '.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer',
      },
      notice: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      success: { color: 'var(--dsw-alias-state-success-primary)' },
      details: { borderTop: '1px dashed var(--dsw-alias-border-l2)', paddingTop: '8px' },
      summary: {
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: '18px',
        listStyle: 'none',
      },
      detailsBody: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px' },
    }

    function at(object, path) {
      let value = object
      for (const segment of path ?? []) {
        if (!value || typeof value !== 'object') return undefined
        value = value[segment]
      }
      return value
    }

    function rowsOf(map) {
      return Object.entries(map ?? {}).map(([name, value]) => ({ name, value }))
    }

    function headersOf(rows) {
      const result = {}
      for (const row of rows) if (row.name.trim()) result[row.name.trim()] = row.value
      return result
    }

    function modelEmpty(model) {
      return (
        !(model?.proxy?.mode && model.proxy.mode !== 'inherit') &&
        !Object.keys(model?.headers ?? {}).length &&
        !(model?.removeHeaders ?? []).length
      )
    }

    function providerEmpty(profile) {
      return (
        !(profile?.proxy?.mode && profile.proxy.mode !== 'inherit') &&
        !Object.keys(profile?.headers ?? {}).length &&
        !Object.keys(profile?.models ?? {}).length
      )
    }

    function checkHeaders(rows) {
      const seen = new Set()
      for (const row of rows) {
        const name = row.name.trim()
        if (!name) {
          if (row.value.trim()) return { key: 'emptyName' }
          continue
        }
        if (!HEADER_NAME.test(name)) return { key: 'badName' }
        if (RESERVED.includes(name.toLowerCase())) return { key: 'reserved', name }
        const low = name.toLowerCase()
        if (seen.has(low)) return { key: 'duplicate', name }
        seen.add(low)
        if (/[\r\n]/.test(row.value)) return { key: 'badValue' }
        const unknown = row.value.replace(MACRO, '')
        if (/\$\{[^}]*\}/.test(unknown)) return { key: 'unknownMacro', name }
      }
      return undefined
    }

    function checkRemoveHeaders(list) {
      for (const name of list ?? []) if (!HEADER_NAME.test(name)) return { key: 'badRemove', name }
      return undefined
    }

    function checkProxy(proxy) {
      if (!proxy || proxy.mode !== 'proxy') return undefined
      try {
        const parsed = new URL(proxy.url || '')
        if (!PROXY_PROTOCOLS.includes(parsed.protocol) || !parsed.hostname) throw new Error('bad')
        return undefined
      } catch {
        return { key: 'badProxy' }
      }
    }

    function nativeModelIds(profile, namespaces, entry) {
      const ids = new Set(Object.keys(profile?.models ?? {}))
      const panel = (namespaces ?? []).find((item) => item.ns === entry?.settingsNs)
      const record = at(panel?.value, entry?.settingsPath ?? [])
      if (record && Array.isArray(record.models)) {
        for (const model of record.models) if (model && typeof model.id === 'string') ids.add(model.id)
      }
      if (record && record.modelOverrides && typeof record.modelOverrides === 'object') {
        for (const key of Object.keys(record.modelOverrides)) ids.add(key)
      }
      return [...ids].sort()
    }

    /* ------------------------------------------------------------------ *
     * Tiny DOM helpers for the injected form.
     * ------------------------------------------------------------------ */
    function create(tag, props, children) {
      const node = document.createElement(tag)
      for (const [key, value] of Object.entries(props ?? {})) {
        if (key === 'style') {
          for (const [name, css] of Object.entries(value ?? {})) {
            try {
              node.style[name] = typeof css === 'number' ? `${css}px` : css
            } catch {
              // Ignore CSS values the environment does not understand.
            }
          }
          continue
        }
        if (key === 'text') {
          node.textContent = String(value)
          continue
        }
        if (key === 'onInput' || key === 'onChange' || key === 'onClick') continue
        if (key === 'value') {
          node.value = value ?? ''
          continue
        }
        if (key === 'disabled') {
          node.disabled = value === true
          continue
        }
        if (value === undefined || value === null) continue
        node.setAttribute(key, String(value))
      }
      for (const child of children ?? []) {
        if (child === undefined || child === null) continue
        node.appendChild(child)
      }
      if (props?.onInput !== undefined) {
        node.addEventListener('input', props.onInput)
        node.addEventListener('change', props.onInput)
      }
      if (props?.onChange !== undefined) node.addEventListener('change', props.onChange)
      if (props?.onClick !== undefined) node.addEventListener('click', props.onClick)
      if (node.tagName === 'SELECT' && props?.value !== undefined) node.value = props.value
      return node
    }

    function button(label, onClick, options = {}) {
      return create('button', {
        type: 'button',
        style: { ...styles.button, ...(options.style ?? {}) },
        text: label,
        ...(options.attrs ?? {}),
        onClick,
      })
    }

    function option(value, label) {
      return create('option', { value, text: label })
    }

    function proxySelect(value, onChange, inheritLabel, directLabel, proxyLabel) {
      const select = create(
        'select',
        {
          style: { ...styles.input, ...styles.select },
          'aria-label': 'proxy',
          value,
          onChange: () => onChange(select.value),
        },
        [option('inherit', inheritLabel), option('direct', directLabel), option('proxy', proxyLabel)],
      )
      select.value = value
      return select
    }

    /** Plain-DOM form for the transport namespace inside one native editor card. */
    function createFields({ t, read, write, providerId, dynamicId, provider, register }) {
      const state = {
        phase: providerId === undefined ? 'ready' : 'loading',
        draft: {},
        revision: undefined,
        providerRows: [],
        modelRows: [],
        modelDraftId: '',
        removedText: '',
        modelId: '',
        modelIds: [],
        notice: '',
        noticeKind: 'info',
        baseline: JSON.stringify({}),
      }
      const providerRef = { current: provider }
      const root = create('div', { style: styles.block })
      const head = create('div', { style: styles.head }, [
        create('span', { style: styles.title, text: t('title') }),
        create('span', { style: styles.hint, text: t('subtitle') }),
      ])
      const dynamicHint = providerId === undefined ? create('p', { style: styles.notice, text: t('dynamicHint') }) : null
      const proxyBox = create('div', { style: styles.section })
      const headersBox = create('div', { style: styles.section })
      const modelBox = create('div', { style: styles.section })
      const macros = create('p', { style: styles.notice, text: t('macros') })
      const noticeEl = create('p', { style: styles.notice, role: 'status' })
      root.append(head)
      if (dynamicHint !== null) root.appendChild(dynamicHint)
      root.append(proxyBox, headersBox, modelBox, macros, noticeEl)

      function dirty() {
        return JSON.stringify(state.draft) !== state.baseline
      }

      function showNotice(message, kind = 'error') {
        state.notice = message
        state.noticeKind = kind
        noticeEl.textContent = message
        Object.assign(noticeEl.style, kind === 'error' ? styles.error : kind === 'success' ? styles.success : {})
      }

      function proxyValue() {
        return state.draft.proxy ?? { mode: 'inherit', url: '' }
      }

      function syncProviderHeaders() {
        state.draft.headers = headersOf(state.providerRows)
      }

      function modelDraft(modelId) {
        state.draft.models = state.draft.models ?? {}
        return state.draft.models[modelId] ?? {}
      }

      function commitModel(modelId, model) {
        state.draft.models = state.draft.models ?? {}
        if (modelEmpty(model)) delete state.draft.models[modelId]
        else state.draft.models[modelId] = model
      }

      function headerRowNodes(rows, onChange) {
        const nodes = []
        rows.forEach((row, index) => {
          nodes.push(
            create('div', { style: styles.row }, [
              create('input', {
                style: { ...styles.input, ...styles.rowInput },
                'aria-label': t('name'),
                placeholder: t('name'),
                value: row.name,
                onInput: (event) => {
                  row.name = event.target.value
                  onChange()
                },
              }),
              create('input', {
                style: { ...styles.input, ...styles.rowInput },
                'aria-label': t('value'),
                placeholder: t('value'),
                value: row.value,
                onInput: (event) => {
                  row.value = event.target.value
                  onChange()
                },
              }),
              button(
                '×',
                () => {
                  rows.splice(index, 1)
                  onChange()
                  renderHeaders()
                  renderModel()
                },
                { attrs: { title: t('removeRow'), 'aria-label': t('removeRow') } },
              ),
            ]),
          )
        })
        nodes.push(
          button(
            `+ ${t('add')}`,
            () => {
              rows.push({ name: '', value: '' })
              onChange()
              renderHeaders()
              renderModel()
            },
            { style: { alignSelf: 'flex-start' } },
          ),
        )
        return nodes
      }

      function renderProxy() {
        const proxy = proxyValue()
        const mode = proxy.mode || 'inherit'
        const select = proxySelect(
          mode,
          (next) => {
            state.draft.proxy = { ...proxyValue(), mode: next }
            renderProxy()
          },
          t('inherit'),
          t('direct'),
          t('via'),
        )
        const nodes = [create('span', { style: styles.fieldLabel, text: t('proxy') }), select]
        if (mode === 'proxy') {
          nodes.push(
            create('input', {
              style: styles.input,
              'aria-label': t('url'),
              placeholder: t('urlHint'),
              value: proxy.url ?? '',
              onInput: (event) => {
                state.draft.proxy = { ...proxyValue(), url: event.target.value }
              },
            }),
          )
        }
        proxyBox.replaceChildren(...nodes)
      }

      function renderHeaders() {
        headersBox.replaceChildren(
          create('span', { style: styles.fieldLabel, text: t('headers') }),
          ...headerRowNodes(state.providerRows, syncProviderHeaders),
        )
      }

      function renderModel() {
        const ids = [...new Set([...state.modelIds, ...Object.keys(state.draft.models ?? {})])].sort()
        const select = create(
          'select',
          {
            style: { ...styles.input, ...styles.select },
            'aria-label': t('modelPick'),
            onChange: () => {
              state.modelId = select.value
              renderModel()
            },
          },
          [option('', t('modelPick')), ...ids.map((id) => option(id, id))],
        )
        select.value = state.modelId
        modelBox.replaceChildren(create('span', { style: styles.fieldLabel, text: t('modelOverrides') }), select)
        const modelId = state.modelId.trim()
        if (!modelId) {
          state.modelDraftId = ''
          state.modelRows = []
          return
        }
        if (state.modelDraftId !== modelId) {
          state.modelDraftId = modelId
          state.modelRows = rowsOf(state.draft.models?.[modelId]?.headers)
          state.removedText = (state.draft.models?.[modelId]?.removeHeaders ?? []).join(', ')
        }
        const model = state.draft.models?.[modelId] ?? {}
        const mode = model.proxy?.mode ?? 'inherit'
        const proxyRow = proxySelect(
          mode,
          (next) => {
            const current = state.draft.models?.[modelId] ?? {}
            commitModel(modelId, { ...current, proxy: { ...(current.proxy ?? {}), mode: next, url: current.proxy?.url ?? '' } })
            renderModel()
          },
          t('modelInherit'),
          t('direct'),
          t('via'),
        )
        modelBox.append(proxyRow)
        if (mode === 'proxy') {
          modelBox.append(
            create('input', {
              style: styles.input,
              'aria-label': t('url'),
              placeholder: t('urlHint'),
              value: model.proxy?.url ?? '',
              onInput: (event) => {
                const current = state.draft.models?.[modelId] ?? {}
                state.draft.models = state.draft.models ?? {}
                state.draft.models[modelId] = {
                  ...current,
                  proxy: { ...(current.proxy ?? {}), mode: 'proxy', url: event.target.value },
                }
              },
            }),
          )
        }
        modelBox.append(create('span', { style: styles.fieldLabel, text: t('headers') }))
        for (const node of headerRowNodes(state.modelRows, () => {
          const current = state.draft.models?.[modelId] ?? {}
          commitModel(modelId, { ...current, headers: headersOf(state.modelRows) })
        })) {
          modelBox.append(node)
        }
        modelBox.append(create('span', { style: styles.fieldLabel, text: t('removeInherited') }))
        modelBox.append(
          create('input', {
            style: styles.input,
            value: state.removedText,
            onInput: (event) => {
              state.removedText = event.target.value
              const current = state.draft.models?.[modelId] ?? {}
              commitModel(modelId, {
                ...current,
                removeHeaders: state.removedText
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            },
          }),
        )
        modelBox.append(
          button(
            t('resetModel'),
            () => {
              state.draft.models = state.draft.models ?? {}
              delete state.draft.models[modelId]
              state.modelId = ''
              state.modelDraftId = ''
              state.modelRows = []
              state.removedText = ''
              renderModel()
            },
            { style: { alignSelf: 'flex-start' } },
          ),
        )
      }

      function render() {
        root.replaceChildren()
        root.append(head)
        if (dynamicHint !== null) root.appendChild(dynamicHint)
        root.append(proxyBox, headersBox, modelBox, macros, noticeEl)
        if (state.phase === 'loading') {
          proxyBox.replaceChildren(create('p', { style: styles.notice, text: t('loading') }))
          headersBox.replaceChildren()
          modelBox.replaceChildren()
          return
        }
        if (state.phase === 'error') {
          proxyBox.replaceChildren(
            create('p', { style: { ...styles.notice, ...styles.error }, text: state.notice || t('loadFailed') }),
            button(t('retry'), () => void load(), { style: { alignSelf: 'flex-start' } }),
          )
          headersBox.replaceChildren()
          modelBox.replaceChildren()
          return
        }
        renderProxy()
        renderHeaders()
        renderModel()
      }

      async function load() {
        if (providerId === undefined) return
        state.phase = 'loading'
        render()
        try {
          const response = await read()
          if (!response.ok) {
            state.phase = 'error'
            state.notice = t('unsupported')
            state.noticeKind = 'error'
            render()
            return
          }
          const profile = structuredClone(response.view.value?.providers?.[providerId] ?? {})
          state.draft = profile
          state.revision = response.view.revision
          state.providerRows = rowsOf(profile.headers)
          state.modelRows = []
          state.modelDraftId = ''
          state.removedText = ''
          state.modelId = ''
          state.modelIds = nativeModelIds(profile, response.namespaces, providerRef.current)
          state.baseline = JSON.stringify(profile)
          state.phase = 'ready'
          state.notice = ''
          state.noticeKind = 'info'
          noticeEl.textContent = ''
          render()
        } catch (error) {
          state.phase = 'error'
          state.notice = String(error?.message ?? error)
          state.noticeKind = 'error'
          render()
        }
      }

      async function performSave() {
        const problem = checkProxy(state.draft.proxy) ?? checkHeaders(state.providerRows)
        if (problem) {
          showNotice(t(problem.key, problem))
          return false
        }
        for (const [name, model] of Object.entries(state.draft.models ?? {})) {
          const issue =
            checkProxy(model.proxy) ?? checkHeaders(rowsOf(model.headers)) ?? checkRemoveHeaders(model.removeHeaders)
          if (issue) {
            showNotice(`${name}: ${t(issue.key, issue)}`)
            return false
          }
        }
        const id = providerId ?? (dynamicId === undefined ? undefined : dynamicId())
        if (id === undefined || id === '') return true
        if (!dirty()) return true
        const op = providerEmpty(state.draft)
          ? { op: 'unset', path: ['providers', id] }
          : { op: 'set', path: ['providers', id], value: structuredClone(state.draft) }
        try {
          const response = await write([op], state.revision)
          if (!response.ok) {
            showNotice(response.conflict ? t('conflict') : response.message)
            return false
          }
          const next = structuredClone(response.view.value?.providers?.[id] ?? {})
          state.draft = next
          state.revision = response.view.revision
          state.providerRows = rowsOf(next.headers)
          state.modelDraftId = ''
          state.modelRows = []
          state.removedText = ''
          state.baseline = JSON.stringify(next)
          render()
          showNotice(t('saved'), 'success')
          return true
        } catch (error) {
          showNotice(String(error?.message ?? error))
          return false
        }
      }

      register({ isDirty: () => dirty(), save: () => performSave() })
      render()
      if (providerId !== undefined) void load()
      return root
    }

    /** Hidden anchor rendered in the provider-card slot; identifies the editor beside it. */
    function Bridge(props) {
      const provider = props.provider
      const providerId = provider?.provider ?? ''
      if (!providerId) return null
      return h('span', {
        'data-dsh-transport-anchor': providerId,
        'data-provider': providerId,
        'aria-hidden': 'true',
        style: { display: 'none' },
        ref: (element) => {
          if (element !== null) element.__dshTransportProvider = provider
        },
      })
    }

    /**
     * Native editor card, recognized by shape only: it owns form controls and
     * ends in an action row of at least two buttons. No CSS-module class name
     * (which is build-specific) is required.
     */
    function isEditorCard(element) {
      if (!element || element.nodeType !== 1) return false
      if (typeof element.querySelector !== 'function') return false
      if (element.querySelector('input, select, textarea') === null) return false
      const footer = element.lastElementChild
      if (!footer) return false
      if (footer.querySelector('input, select, textarea') !== null) return false
      return footer.querySelectorAll('button').length >= 2
    }

    function submitOf(card) {
      const footer = card ? card.lastElementChild : null
      if (!footer) return null
      const buttons = footer.querySelectorAll('button')
      return buttons.length === 0 ? null : buttons[buttons.length - 1]
    }

    /** The editor card next to the anchor, walking up through possible wrappers. */
    function findAdjacentCard(anchor) {
      let node = anchor
      for (let depth = 0; depth < 3; depth += 1) {
        if (!node) return null
        for (const sibling of [node.previousElementSibling, node.nextElementSibling]) {
          if (sibling && isEditorCard(sibling)) return sibling
        }
        node = node.parentElement ?? node.parentNode
      }
      return null
    }

    function findCustomCard(panel) {
      if (typeof panel.querySelectorAll !== 'function') return null
      for (const candidate of panel.querySelectorAll('*')) {
        if (isEditorCard(candidate)) return candidate
      }
      return null
    }

    function routeValue(card) {
      const input = card.querySelector('input[type="text"]')
      return input === null ? '' : String(input.value ?? '').trim()
    }

    /** DOM bridge: mount the fields inside native provider editors, share their Save button. */
    function createBridge({ t, read, write, doc, context }) {
      const records = new Map()
      const bypass = new WeakSet()
      const debug = globalThis.__dshProviderTransport
      let observer
      let scheduled = false
      let localeDispose

      function findCards() {
        const found = []
        const claimed = new Set()
        for (const anchor of doc.querySelectorAll('[data-dsh-transport-anchor]')) {
          const card = findAdjacentCard(anchor)
          const providerId = anchor.getAttribute('data-provider')
          if (card === null || !providerId || claimed.has(card)) continue
          claimed.add(card)
          found.push({ card, providerId, provider: anchor.__dshTransportProvider })
        }
        for (const panel of doc.querySelectorAll('[id$="-custom-panel"]')) {
          const card = findCustomCard(panel)
          if (card === null || claimed.has(card)) continue
          claimed.add(card)
          found.push({ card, providerId: undefined, provider: undefined })
        }
        return found
      }

      /** Snapshot of the anchor neighbourhood, for the console diagnostic. */
      function inspectAnchors(debug) {
        if (debug === undefined) return
        const anchors = [...doc.querySelectorAll('[data-dsh-transport-anchor]')]
        // Prefer an anchor whose editor is open, so the sample describes the
        // expansion the user is actually looking at.
        const anchor = anchors.find((candidate) => findAdjacentCard(candidate) !== null) ?? anchors[0]
        if (!anchor) {
          debug.sample = null
          return
        }
        const describe = (element) =>
          element === null || element === undefined
            ? null
            : `${element.tagName ?? '?'}.${String(element.getAttribute?.('class') ?? '').replace(/\s+/g, '.')}`
        const parent = anchor.parentElement ?? anchor.parentNode ?? null
        const children = parent && parent.children ? [...parent.children].map(describe) : []
        debug.sample = {
          anchor: describe(anchor),
          parent: describe(parent),
          parentChildren: children,
          editorFound: findAdjacentCard(anchor) !== null,
        }
      }

      function mount({ card, providerId, provider }) {
        const footer = card.lastElementChild
        if (!footer) return
        const token = providerId ?? DYNAMIC
        const container = doc.createElement('div')
        container.setAttribute('data-dsh-transport-ui', '')
        footer.before(container)
        card.setAttribute('data-dsh-transport-card', token)
        const record = { card, container, token, controller: undefined, listener: null }
        const fields = createFields({
          t,
          read,
          write,
          providerId,
          provider,
          dynamicId: providerId === undefined ? () => routeValue(card) : undefined,
          register: (value) => {
            record.controller = value
          },
        })
        container.appendChild(fields)
        record.listener = (event) => {
          const submit = submitOf(card)
          if (submit === null || !submit.contains(event.target)) return
          if (bypass.has(submit)) return
          const controller = record.controller
          if (!controller || !controller.isDirty()) return
          event.preventDefault()
          event.stopPropagation()
          void controller.save().then((ok) => {
            if (!ok) return
            const live = [...doc.querySelectorAll('[data-dsh-transport-card]')].find(
              (element) => element.getAttribute('data-dsh-transport-card') === token,
            )
            const target = submitOf(live ?? card) ?? submit
            if (target.disabled) return
            bypass.add(target)
            try {
              target.click()
            } finally {
              setTimeout(() => bypass.delete(target), 0)
            }
          })
        }
        card.addEventListener('click', record.listener, true)
        record.dispose = () => {
          if (record.listener !== null) card.removeEventListener('click', record.listener, true)
          if (card.getAttribute('data-dsh-transport-card') === token) card.removeAttribute('data-dsh-transport-card')
          container.remove()
        }
        records.set(card, record)
      }

      function scan() {
        if (!doc?.body) return
        if (debug !== undefined) debug.scans += 1
        for (const [card, record] of records) {
          if (record.container.isConnected) continue
          record.dispose()
          records.delete(card)
        }
        const found = findCards()
        if (debug !== undefined) {
          debug.anchors = doc.querySelectorAll('[data-dsh-transport-anchor]').length
          debug.cards = found.length
          debug.mounted = records.size
          inspectAnchors(debug)
        }
        for (const entry of found) {
          if (records.has(entry.card)) continue
          mount(entry)
          if (debug !== undefined) debug.mounted = records.size
        }
      }

      function schedule() {
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          try {
            scan()
          } catch (error) {
            if (debug !== undefined) debug.lastError = String(error?.stack ?? error)
            console.error('provider-transport: editor bridge failed', error)
          }
        })
      }

      let ticker

      return {
        start() {
          if (!doc?.body) return
          observer = new MutationObserver(schedule)
          observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
          localeDispose = context?.on?.('locale/change', schedule, { global: true })
          ticker = setInterval(schedule, 1500)
          schedule()
        },
        stop() {
          localeDispose?.()
          localeDispose = undefined
          observer?.disconnect()
          observer = undefined
          if (ticker !== undefined) clearInterval(ticker)
          ticker = undefined
          for (const record of records.values()) record.dispose()
          records.clear()
        },
      }
    }

    const inject = ['slots', 'remote', 'remote.settings', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(COPY, translations), 'provider-transport: locale')
      const t = ctx.locale.bind(COPY)
      const api = {
        read: async () => {
          const response = await ctx.remote.settings.describe()
          if (!response.ok) return { ok: false, message: response.error?.message ?? 'describe failed' }
          const view = response.value.namespaces.find((item) => item.ns === NS)
          if (view === undefined) return { ok: false, message: t('unsupported') }
          return { ok: true, view, namespaces: response.value.namespaces }
        },
        write: async (ops, revision) => {
          const response = await ctx.remote.settings.mutate(NS, ops, revision)
          if (response.ok) return { ok: true, view: response.value }
          return {
            ok: false,
            conflict: response.error?.code === 'settings/conflict',
            message: response.error?.message ?? 'mutate failed',
          }
        },
      }
      if (globalThis.__dshProviderTransport === undefined) {
        globalThis.__dshProviderTransport = { scans: 0, anchors: 0, cards: 0, mounted: 0, lastError: null }
      }
      const bridge = createBridge({ t, read: api.read, write: api.write, doc: globalThis.document, context: ctx })
      ctx.effect(() => {
        bridge.start()
        return () => bridge.stop()
      }, 'provider-transport: provider editor bridge')
      for (const key of SEATS) {
        ctx.slots.inject('settings.models.provider-card', () =>
          ctx.slots.register({ name: 'settings.models.provider-card', key, locale: COPY }, Bridge),
        )
      }
    }

    const module = { exports: {} }
    module.exports = { apply, inject, _internals: { isEditorCard, submitOf, findAdjacentCard, findCustomCard } }
    return module.exports
  },
})
