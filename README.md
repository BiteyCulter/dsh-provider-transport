# dsh-provider-transport

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

> 非官方社区插件，与 DeepSeek 无隶属或背书关系。<br>
> Unofficial community plugin, not affiliated with or endorsed by DeepSeek.

## 这是什么 / What it is

给 DSH 的原生 Provider 补一层网络配置：每个 Provider、每个 Model 都可以单独设置 HTTP/HTTPS/SOCKS 代理并附加自定义请求头。凭据、模型目录、协议转换和流式处理仍由 DSH 负责，插件只在模型请求这一处生效。

A thin networking layer for DSH's native providers: each provider and each model can use its own HTTP/HTTPS/SOCKS proxy and add custom request headers. Credentials, model catalogs, protocol conversion, and streaming stay with DSH — the plugin only touches a model request.

已在 DSH 0.2.2-rc.1（Windows）端到端验证通过：面板、代理链路、请求头和 TLS 流式回复均正常。

Verified end to end on DSH 0.2.2-rc.1 (Windows): panel, proxy path, headers, and TLS streaming replies all work.

## 功能 / Features

| 中文 | English |
| --- | --- |
| 代理与请求头字段直接出现在原生 Provider 的创建/编辑表单中，共用原生保存/取消按钮。 | Proxy and header fields appear in the native provider create/edit form, sharing the Save/Cancel buttons. |
| Model 级覆盖：继承 Provider 设置、直连，或指定自己的代理与请求头。 | Per-model overrides: inherit, go direct, or set a model-specific proxy and headers. |
| 支持 HTTP/HTTPS 正向代理、SOCKS5/SOCKS5H，以及 Basic / 用户名密码认证。 | HTTP/HTTPS forward proxies, SOCKS5/SOCKS5H, and Basic or username/password auth. |
| 请求头支持 `${sessionId}`、`${provider}`、`${model}`、`${purpose}` 宏；动态值缺失时跳过该头，不会发出占位符。 | Headers support `${sessionId}`, `${provider}`, `${model}`, `${purpose}` macros; if a value is missing for a request, the header is skipped rather than sent as a placeholder. |
| 保存即生效，无需重启 DSH。 | Changes apply on save; no DSH restart. |
| 无 npm 运行时依赖，仅用 Node 内置模块和 DSH 自带的 `@deepseek-ai/schemastery`。 | Zero npm runtime dependencies — Node built-ins plus DSH's own `@deepseek-ai/schemastery`. |

## 环境要求 / Requirements

- DSH 0.2.2-rc.1（扩展点基于该版本验证），Web 或 Desktop 均可<br>DSH 0.2.2-rc.1 (extension points verified on this build), Web or Desktop
- Node.js ≥ 22（DSH 运行时）<br>Node.js ≥ 22 (DSH runtime)

## 安装 / Install

```bash
git clone https://github.com/BiteyCulter/dsh-provider-transport.git
cd dsh-provider-transport

# 链接进 profile，然后重启 DSH；Desktop 版把 web 换成 desktop
# Link into a profile, then restart DSH; use --profile desktop for the desktop app
dsh plugin --profile web add "$(pwd)"
```

无需 `npm install`：插件本身没有运行时依赖，linked 插件的 peer 依赖由 DSH 安装树解析。

No `npm install` needed: the plugin has no runtime dependencies, and a linked plugin's peer dependencies resolve from the DSH installation tree.

## 使用 / Usage

1. 打开**设置 → 模型**，展开 Provider 卡片，点**编辑**（或新建一个）。<br>Open **Settings → Models**, expand a provider card, and click **Edit** (or start creating one).
2. 原生编辑器内、取消/保存按钮上方会出现**网络代理与请求头**：选择代理、添加请求头，可按需添加 Model 覆盖。<br>Inside the native editor, above the Cancel/Save row, you'll find **Proxy & Request Headers**: pick a proxy, add headers, and optionally add per-model overrides.
3. 点一次**保存**即可：插件先写自己的配置，再放行原生保存；点**取消**则两边草稿一起丢弃。<br>Click **Save** once: the plugin writes its own configuration first, then lets the native save run; **Cancel** discards both drafts.

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

- 代理优先级：Model（非 `inherit`）→ Provider（非 `inherit`）→ DSH 原生连接。<br>Proxy priority: Model (non-`inherit`) → Provider (non-`inherit`) → DSH native connection.
- 请求头合并：Provider 默认 → 剔除 Model `removeHeaders` → Model 覆盖或新增，名称大小写不敏感。<br>Header merge: provider defaults → minus model `removeHeaders` → model overrides/additions; names are case-insensitive.

`Authorization`、`Proxy-Authorization`、`Host`、`Content-Length`、`User-Agent`、`Connection`、`Transfer-Encoding` 等由 DSH 或 HTTP 层管理的头不可覆盖；保存前会校验名称、值与宏。

Headers managed by DSH or the HTTP layer (`Authorization`, `Proxy-Authorization`, `Host`, `Content-Length`, `User-Agent`, `Connection`, `Transfer-Encoding`, …) cannot be overridden; names, values, and macros are validated before saving.

## 本地调试：请求头真的发出去没 / Debug locally: are the headers really sent?

仓库里带了一个不依赖 DSH 的请求探针，用来确认请求头确实落到了上游请求上。

The repo ships a standalone request probe that shows whether your headers really reach the upstream request.

```bash
npm run probe                 # 假上游 127.0.0.1:18080 + 正向代理 127.0.0.1:18081
node tools/header-probe.mjs --port 18080 --proxy-port 18081   # 自定义端口 / custom ports
```

1. 打开 `http://127.0.0.1:18080/` 看实时面板；终端也会逐条打印方法、URL 和收到的全部请求头。
   Open `http://127.0.0.1:18080/` for the live dashboard; the terminal also prints method, URL, and every received header.
2. 设置 → 模型 → 新建自定义 Provider：baseURL 填 `http://127.0.0.1:18080/v1`（OpenAI 兼容）或 `http://127.0.0.1:18080`（Anthropic Messages），模型随便填一个。
   Settings → Models → create a custom provider: set baseURL to `http://127.0.0.1:18080/v1` (OpenAI-compatible) or `http://127.0.0.1:18080` (Anthropic Messages), and add any model id.
3. 在该 Provider 的**网络代理与请求头**里加一个测试头，比如 `x-dsh-probe: ${provider}/${model}`，保存，然后发一条消息。
   Add a test header such as `x-dsh-probe: ${provider}/${model}` under **Proxy & Request Headers** for that provider, save, and send a message.
4. 想同时验证代理，把 Proxy 设成 `http://127.0.0.1:18081` 再发一次：forward-proxy 会记录绝对 URL 与请求头，然后转发到假上游。
   To verify the proxy path too, set Proxy to `http://127.0.0.1:18081` and send again: the forward proxy records the absolute URL and headers, then forwards to the fake upstream.

探针会把捕获结果追加到 `probe-capture.jsonl`（已加入 `.gitignore`），并返回最小 SSE 响应，让 DSH 能正常结束这次调用。它只监听 127.0.0.1，不接触真实 Provider。

The probe appends captures to `probe-capture.jsonl` (git-ignored) and answers with a minimal SSE stream so DSH can finish the call. It only listens on 127.0.0.1 and never touches a real provider.

## 工作原理 / How it works

插件只通过 DSH 的扩展点挂接，未改动 DSH 源码。

The plugin hooks into DSH's own extension points; DSH sources are untouched.

- `llm/stream` waterfall 配合 `AsyncLocalStorage`，为一条完整的模型流开启作用域，异步生成器每次 pull 都在作用域内。<br>An `llm/stream` waterfall plus `AsyncLocalStorage` opens a scope for one complete model stream, including every async-generator pull.
- 上游真实 endpoint 的 origin 来自 `llm-pi-ai/request-headers`，pi-ai 系请求头也通过这个官方事件注入。<br>The upstream origin comes from `llm-pi-ai/request-headers`, which also carries header injection for pi-ai routes.
- 作用域内的 `fetch` 包装器只改写 origin 匹配的请求，交给自带的代理传输。<br>Inside the scope, the `fetch` wrapper rewrites only origin-matching requests, handing them to the built-in proxy transport.
- `deepseek-official` / `deepseek-account` 不发上述事件，且单次请求只访问自家 endpoint，因此按整个作用域路由。<br>`deepseek-official` / `deepseek-account` don't emit that event and only talk to their own endpoint, so they are routed whole-scope.
- 作用域之外的请求——工具调用、模型发现、鉴权刷新——完全不受影响。<br>Everything outside the scope — tool calls, model discovery, auth refresh — is left alone.
- 代理传输只用 Node 内置模块：CONNECT、absolute-form、SOCKS5/5H、TLS 校验、解压、重定向、`AbortSignal` 和流式 body。<br>The proxy transport uses Node built-ins only: CONNECT, absolute-form, SOCKS5/5H, TLS verification, decompression, redirects, `AbortSignal`, and streaming bodies.
- 设置界面通过隐藏锚点加结构识别挂到原生编辑卡上，不依赖构建生成的 CSS 类名。<br>The settings UI mounts into the native editor card via a hidden anchor plus structural detection, independent of build-generated CSS class names.

## 安全 / Security

- 代理与请求头配置以明文保存在 DSH profile 中，请把它当普通配置而非密钥库；API Key 仍由 DSH 的凭据存储管理。<br>Proxy/header configuration is stored in plain text in the DSH profile — treat it as configuration, not a secret store; DSH still manages API keys.
- 代理 URL 可内嵌凭据，日志中会自动打码。<br>Proxy URLs may embed credentials; they are masked in logs.
- TLS 校验始终开启，没有"忽略证书"选项。<br>TLS verification is always on; there is no "ignore certificate errors" switch.
- 不修改 `HTTP_PROXY` / `HTTPS_PROXY`，也不安装全局 dispatcher。<br>No `HTTP_PROXY` / `HTTPS_PROXY` changes and no global dispatcher.

## 兼容性与边界 / Compatibility & limitations

- 只覆盖通过 `globalThis.fetch` 发起模型请求的适配器：pi-ai 系与 DSH 一方 DeepSeek 适配器。<br>Covers only adapters that issue model requests via `globalThis.fetch`: pi-ai routes and DSH's first-party DeepSeek adapters.
- 模型发现请求不走代理。<br>Model discovery requests are not proxied.
- 自带 HTTP 栈的第三方 SDK（AWS SDK、gRPC、WebSocket 等）不会被代理。<br>Third-party SDKs with their own HTTP stack (AWS SDK, gRPC, WebSocket, …) are not proxied.
- 设置界面依赖原生编辑器的 DOM 结构，DSH 大版本升级后可能需要适配。<br>The settings UI depends on the native editor's DOM structure and may need adaptation after a major DSH release.

## 排障 / Troubleshooting

- **编辑器里没有这一段**：重启 DSH 并强制刷新，在 Console 里查看 `window.__dshProviderTransport`。<br>**Section missing from the editor**: restart DSH, hard-refresh, then inspect `window.__dshProviderTransport` in the console.
- `anchors = 0`：客户端 bundle 未加载，或 Provider 卡片未渲染。<br>`anchors = 0`: the client bundle didn't load, or the provider card didn't render.
- `anchors > 0` 且 `cards = 0`：编辑卡未被识别，可查看 `sample` 中记录的锚点邻居结构（`cards` 仅在编辑卡打开时大于 0）。<br>`anchors > 0` with `cards = 0`: the editor card wasn't recognized; check the anchor neighbourhood recorded in `sample` (`cards` is only non-zero while an editor is open).
- **模型请求报 `Connection error.` / `TRANSPORT` 并重试**：请求已被接管但代理连不上；宿主日志中查找 `provider-transport:` 前缀的记录，其中写明了 provider、model、代理地址和具体原因。<br>**Model calls fail with `Connection error.` / `TRANSPORT` and retries**: the request was intercepted but the proxy is unreachable; the host log has a `provider-transport:` line with the provider, model, proxy, and cause.
- 需要更详细的链路日志时，用 `DSH_PROVIDER_TRANSPORT_DEBUG=1` 启动 DSH。<br>For verbose transport logs, start DSH with `DSH_PROVIDER_TRANSPORT_DEBUG=1`.

## 测试 / Tests

```bash
npm run check        # 语法检查 / syntax check
npm test             # 36 个离线测试 / 36 offline tests
npm run test:bridge  # 20 项 DOM 桥检查 / 20 DOM-bridge checks
npm run test:smoke   # 加载真实 index.js / loads the real index.js (needs DSH's schemastery)
npm run test:tls     # HTTPS 经 CONNECT/SOCKS5H + 流式增量 / needs openssl
```

TLS 测试会往 `tests/.certs` 生成一次性自签证书，该目录已在 `.gitignore` 中。

TLS tests generate a throwaway self-signed certificate into `tests/.certs`, which is git-ignored.

## 许可证 / License

[MIT](./LICENSE)
