# dsh-provider-transport

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

> **声明 / Notice**<br>
> 本项目由 AI 构建，不喜勿用。<br>
> This project was built by AI. If that's not your thing, please don't use it.

## 这是什么 / What it is

给 DSH 的原生 Provider 补上一层网络配置：每个 Provider（以及每个 Model）可以用自己的 HTTP/HTTPS/SOCKS 代理，并附加自定义请求头。凭据、模型目录、协议转换和流式处理仍然由 DSH 负责，插件只在一次模型请求上做这两件事。

A thin networking layer for DSH's native providers: each provider (and each model) can use its own HTTP/HTTPS/SOCKS proxy and add custom request headers. Credentials, model catalogs, protocol conversion, and streaming stay with DSH; the plugin only touches those two things on a model request.

已在 DSH 0.2.2-rc.1（Windows）上做过端到端验证：面板、代理链路、请求头和 TLS 流式回复都正常工作。

Verified end to end on DSH 0.2.2-rc.1 (Windows): panel, proxy path, headers, and TLS streaming replies all work.

> 非官方社区插件，与 DeepSeek 无隶属或背书关系。<br>
> Unofficial community plugin, not affiliated with or endorsed by DeepSeek.

## 功能 / Features

| 中文 | English |
| --- | --- |
| 在原生 Provider 的**创建 / 编辑表单**里直接多出代理与请求头字段，和原生字段共用同一个保存 / 取消按钮。 | Proxy and header fields appear inside the native provider **create/edit form** and share the same Save/Cancel buttons. |
| Provider 默认值 + Model 覆盖：继承、直连、或指定自己的代理与请求头。 | Provider defaults plus per-model overrides: inherit, go direct, or set a model-specific proxy and headers. |
| 支持 HTTP/HTTPS 正向代理、SOCKS5 / SOCKS5H，以及 Basic / 用户名密码认证。 | HTTP/HTTPS forward proxies, SOCKS5/SOCKS5H, and Basic or username/password auth. |
| 请求头支持 `${sessionId}`、`${provider}`、`${model}`、`${purpose}` 宏；某个动态值缺失时直接跳过该头，不会发出占位符。 | Headers support `${sessionId}`, `${provider}`, `${model}`, `${purpose}`; if a value is missing for a request, that header is skipped rather than sent as a placeholder. |
| 保存即生效，不用重启 DSH。 | Saves apply immediately; no DSH restart. |
| 没有 npm 运行时依赖：只用 Node 内置模块和 DSH 自带的 `@deepseek-ai/schemastery`。 | No npm runtime dependencies: Node built-ins plus DSH's own `@deepseek-ai/schemastery`. |

## 环境要求 / Requirements

| 中文 | English |
| --- | --- |
| DSH 0.2.2-rc.1（扩展点基于该版本验证），Web 或 Desktop 均可 | DSH 0.2.2-rc.1 (the extension points were verified on this build), Web or Desktop |
| Node.js ≥ 22（DSH 运行时） | Node.js ≥ 22 (the DSH runtime) |

## 安装 / Install

```bash
git clone https://github.com/BiteyCulter/dsh-provider-transport.git
cd dsh-provider-transport

# 链接进 profile，之后重启 DSH
# Link it into a profile, then restart DSH
dsh plugin --profile web add "$(pwd)"
```

Desktop 版把 `web` 换成 `desktop`。这里不需要 `npm install`：插件本身没有运行时依赖，linked 插件的 peer 依赖由 DSH 安装树解析。

For the desktop app use `--profile desktop`. No `npm install` is needed: the plugin has no runtime dependencies, and a linked plugin's peer dependencies resolve from the DSH installation tree.

## 使用 / Usage

1. 打开**设置 → 模型**，展开 Provider 卡片，点**编辑**（或者开始创建一个）。<br>
   Open **Settings → Models**, expand a provider card, and click **Edit** (or start creating one).
2. 在原生编辑器里、取消/保存按钮上方，会出现**网络代理与请求头**：选代理、加请求头，需要的话再加 Model 覆盖。<br>
   Inside the native editor, above the Cancel/Save row, you'll find **Proxy & Request Headers**: pick a proxy, add headers, and optionally add per-model overrides.
3. 点一次**保存**即可。插件先写自己的配置，再放行原生保存；点**取消**则两边草稿一起丢弃。<br>
   Click **Save** once. The plugin writes its own configuration first and then lets the native save run; **Cancel** discards both drafts.

## 配置示例 / Configuration example

```yaml
- id: provider-transport
  name: dsh-provider-transport
  config:
    providers:
      opencode-go:
        proxy:
          mode: proxy
          url: socks5h://127.0.0.1:1080
        headers:
          x-opencode-session: ${sessionId}
          x-provider: ${provider}
        models:
          fast:
            proxy:
              mode: direct
            headers:
              x-model: ${model}
            removeHeaders:
              - x-opencode-session
```

- 代理优先级：Model（非 `inherit`）→ Provider（非 `inherit`）→ DSH 原生连接。<br>
  Proxy priority: Model (non-`inherit`) → Provider (non-`inherit`) → DSH native connection.
- 请求头合并：Provider 默认 → Model `removeHeaders` 排除 → Model 覆盖或新增，名称大小写不敏感。<br>
  Header merge: Provider defaults → Model `removeHeaders` exclusions → Model overrides/additions, case-insensitive.

`Authorization`、`Proxy-Authorization`、`Host`、`Content-Length`、`User-Agent`、`Connection`、`Transfer-Encoding` 等由 DSH 或 HTTP 层管理的头不允许覆盖，保存前会校验名称、值与宏。

Headers managed by DSH or the HTTP layer — `Authorization`, `Proxy-Authorization`, `Host`, `Content-Length`, `User-Agent`, `Connection`, `Transfer-Encoding`, and the like — cannot be overridden; names, values, and macros are validated before saving.

## 工作原理 / How it works

插件通过 DSH 自己的扩展点挂接，没有修改 DSH 源码。

The plugin hooks into DSH's own extension points; DSH sources are untouched.

- 用 `llm/stream` waterfall 加 `AsyncLocalStorage`，为一条完整的模型流开作用域，异步生成器每次 pull 都在作用域内。<br>
  An `llm/stream` waterfall plus `AsyncLocalStorage` opens a scope for one complete model stream, including every async-generator pull.
- 上游真实 endpoint 的 origin 来自 `llm-pi-ai/request-headers`；pi-ai 系的请求头也走这个官方事件注入。<br>
  The real upstream origin comes from `llm-pi-ai/request-headers`, which also carries header injection for pi-ai routes.
- 作用域内的 `fetch` 包装器只在 origin 匹配时改写请求，把它交给自带的代理传输。<br>
  Inside the scope, the `fetch` wrapper rewrites only requests whose origin matches, handing them to the built-in proxy transport.
- `deepseek-official` / `deepseek-account` 不发上面的事件，且单次请求只访问自家 endpoint，所以按整个作用域路由。<br>
  `deepseek-official` / `deepseek-account` don't emit that event and only talk to their own endpoint during a request, so they are routed whole-scope.
- 工具调用、模型发现、鉴权刷新等作用域之外的请求完全不受影响。<br>
  Everything outside the scope — tool calls, model discovery, auth refresh — is left alone.
- 代理传输只用 Node 内置模块：CONNECT、absolute-form、SOCKS5/5H、TLS 校验、解压、重定向、`AbortSignal` 和流式 body。<br>
  The proxy transport uses Node built-ins only: CONNECT, absolute-form, SOCKS5/5H, TLS verification, decompression, redirects, `AbortSignal`, and streaming bodies.
- 设置界面通过隐藏锚点加结构识别挂到原生编辑卡上，不依赖构建会产生变化的 CSS 类名。<br>
  The settings UI mounts into the native editor card via a hidden anchor plus structural detection, so it doesn't depend on build-generated CSS class names.

## 安全 / Security

- 代理和请求头配置以明文保存在 DSH profile 里，把它当配置，不要当密钥库；API Key 仍由 DSH 的凭据存储管理。<br>
  Proxy/header configuration is stored in the DSH profile in plain text. Treat it as configuration, not a secret store; DSH still manages API keys.
- 代理 URL 可以带凭据，日志里会被打码。<br>
  Proxy URLs may embed credentials; they are masked in logs.
- TLS 校验始终开启，没有"忽略证书"的开关。<br>
  TLS verification is always on; there is no "ignore certificate errors" switch.
- 不修改 `HTTP_PROXY` / `HTTPS_PROXY`，也不安装全局 dispatcher。<br>
  No `HTTP_PROXY` / `HTTPS_PROXY` changes and no global dispatcher.

## 兼容性与边界 / Compatibility & limitations

- 只覆盖通过 `globalThis.fetch` 发模型请求的适配器：pi-ai 系和 DSH 一方 DeepSeek 适配器。<br>
  Covers only adapters that issue model requests through `globalThis.fetch`: pi-ai routes and DSH's first-party DeepSeek adapters.
- 模型发现请求不走代理。<br>
  Model discovery requests are not proxied.
- 自带 HTTP 栈的第三方 SDK（AWS SDK、gRPC、WebSocket 等）不会被代理。<br>
  Third-party SDKs with their own HTTP stack (AWS SDK, gRPC, WebSocket, ...) are not proxied.
- 设置界面依赖原生编辑器的 DOM 结构；DSH 大版本改动后可能需要同步适配。<br>
  The settings UI depends on the native editor's DOM structure; a future DSH major release may need adaptation.

## 排障 / Troubleshooting

- **编辑器里没有这一段**：重启 DSH 并强制刷新，然后在 Console 里看 `window.__dshProviderTransport`。<br>
  **Section missing from the editor**: restart DSH, hard-refresh, then inspect `window.__dshProviderTransport` in the console.
- `anchors = 0`：客户端 bundle 没加载，或 Provider 卡片座位没有渲染。<br>
  `anchors = 0`: the client bundle didn't load, or the provider card seat didn't render.
- `anchors > 0` 且 `cards = 0`：编辑卡没有被识别，看 `sample` 里记录的锚点邻居结构（`cards` 只在编辑卡打开时大于 0）。<br>
  `anchors > 0` with `cards = 0`: the editor card wasn't recognized; `sample` records the anchor's neighbourhood (`cards` is only non-zero while an editor is open).
- **模型请求报 `Connection error.` / `TRANSPORT` 并重试**：请求已经被接管，但代理连不上；宿主日志里能找到带 `provider-transport:` 前缀的记录，写明 provider、model、代理地址和具体原因。<br>
  **Model calls fail with `Connection error.` / `TRANSPORT` and retries**: the request was intercepted but the proxy is unreachable; the host log has a `provider-transport:` line with the provider, model, proxy, and cause.
- 需要更细的链路日志时，用 `DSH_PROVIDER_TRANSPORT_DEBUG=1` 启动 DSH。<br>
  For verbose transport logs, start DSH with `DSH_PROVIDER_TRANSPORT_DEBUG=1`.

## 测试 / Tests

```bash
npm run check        # 语法检查 / syntax check
npm test             # 36 个离线测试 / 36 offline tests
npm run test:bridge  # 20 项 DOM 桥检查 / 20 DOM-bridge checks
npm run test:smoke   # 加载真实 index.js / loads the real index.js (needs DSH's schemastery)
npm run test:tls     # HTTPS 经 CONNECT/SOCKS5H + 流式增量 / needs openssl
```

TLS 测试会往 `tests/.certs` 生成一次性自签证书，该目录已在 `.gitignore` 里。

TLS tests generate a throwaway self-signed certificate into `tests/.certs`, which is git-ignored.

## 许可证 / License

[MIT](./LICENSE)
