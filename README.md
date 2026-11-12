# dsh-provider-transport

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

为 **DeepSeek Harness (DSH)** 原生 Provider 增加按 Provider / 按 Model 的 HTTP(S)/SOCKS 代理与自定义请求头。
Per-provider HTTP/HTTPS/SOCKS proxy and custom request headers for **DeepSeek Harness (DSH)** native providers.

不替换凭据、模型目录或协议转换；DSH 继续负责鉴权、模型发现与流式处理。
It does not replace credentials, model catalogs, or protocol conversion; DSH keeps owning auth, model discovery, and streaming.

已在 DSH 0.2.2-rc.1（Windows）完成端到端验证：配置、代理链路、请求头与 TLS 流式回复均正常。
End-to-end verified on DSH 0.2.2-rc.1 (Windows): configuration, proxy routing, request headers, and TLS streaming replies.

非官方社区插件，与 DeepSeek 无隶属或背书关系。
Unofficial community plugin, not affiliated with or endorsed by DeepSeek.

## 功能 Features

- 字段直接注入原生 Provider 的创建 / 编辑表单，和原生字段共用同一个保存 / 取消按钮。
  Fields are injected into the native provider create/edit form and share its single Save/Cancel buttons.
- Provider 级与 Model 级两层配置：继承、跳过或覆盖代理与请求头。
  Provider-level and per-model overrides: inherit, bypass, or override proxy and headers.
- 代理模式：`inherit`、`direct`、`http(s)://`、`socks5://`、`socks5h://`（支持 Basic / 用户名密码认证）。
  Proxy modes: `inherit`, `direct`, `http(s)://`, `socks5://`, `socks5h://` (with Basic or username/password auth).
- 自定义请求头支持宏 `${sessionId}`、`${provider}`、`${model}`、`${purpose}`；缺失动态值时不发送该头。
  Custom headers support `${sessionId}`, `${provider}`, `${model}`, `${purpose}` macros; a header with a missing dynamic value is omitted.
- 保存后实时生效，无需重启 DSH。
  Changes apply live after saving; no DSH restart needed.
- 零 npm 运行时依赖：只用 Node 内置模块 + DSH 自带的 `@deepseek-ai/schemastery`。
  Zero npm runtime dependencies: Node built-ins plus DSH's own `@deepseek-ai/schemastery` only.

## 环境要求 Requirements

- DSH **0.2.2-rc.1**（扩展点已在该构建验证），Web 或 Desktop。
  DSH **0.2.2-rc.1** (extension points verified on this build), Web or Desktop.
- Node.js **≥ 22**（DSH 运行时）。
  Node.js **≥ 22** (the DSH runtime).

## 安装 Install

```bash
git clone https://github.com/BiteyCulter/dsh-provider-transport.git
cd dsh-provider-transport

# 链接进 profile，然后重启 DSH
# link the source into a profile, then restart DSH
dsh plugin --profile web add "$(pwd)"
```

Desktop 版把 `--profile web` 换成 `--profile desktop`。
Use `--profile desktop` instead of `--profile web` for the desktop app.

不需要 `npm install`：插件没有运行时依赖，linked 插件的 peer 依赖由 DSH 安装树解析。
No `npm install` is needed: the plugin has no runtime dependencies, and a linked plugin's peer dependencies resolve from the DSH installation tree.

## 使用 Usage

1. 打开「设置 → 模型」，展开 Provider 卡片并点「编辑」（或开始创建）。
   Open **Settings → Models**, expand a provider card and click **Edit** (or start creating one).
2. 在原生编辑器里、取消/保存按钮之前会出现「网络代理与请求头」。
   **Proxy & Request Headers** appears inside the native editor, before the Cancel/Save row.
3. 选择代理、填写请求头、按需添加 Model 覆盖，然后点一次「保存」。
   Choose a proxy, add headers, optionally add per-model overrides, then click **Save** once.

取消会把两边草稿一起丢弃；不会出现第二套保存逻辑。
Cancel discards both drafts; there is no second save button.

## 配置示例 Configuration example

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

优先级：Model（非 `inherit`）→ Provider（非 `inherit`）→ DSH 原生连接。
Priority: Model (non-`inherit`) → Provider (non-`inherit`) → DSH native connection.

请求头合并：Provider 默认 → Model `removeHeaders` 排除 → Model 覆盖/新增，名称大小写不敏感。
Header merge: Provider defaults → Model `removeHeaders` exclusions → Model overrides/additions, case-insensitive.

## 宏 Macros

- `${sessionId}`：该请求所属 DSH 会话 id。
  `${sessionId}`: DSH session id of the request.
- `${provider}`：原生 provider id（原样）。
  `${provider}`: native provider id (verbatim).
- `${model}`：原生 model id（原样）。
  `${model}`: native model id (verbatim).
- `${purpose}`：辅助调用的用途（存在时）。
  `${purpose}`: purpose of the auxiliary call, when present.

## 请求头规则 Header rules

- 以下头由 DSH / HTTP 层管理，不能覆盖：`Authorization`、`Proxy-Authorization`、`Host`、`Content-Length`、`User-Agent`、`Connection`、`Transfer-Encoding` 等。
  Headers managed by DSH or the HTTP layer cannot be overridden: `Authorization`, `Proxy-Authorization`, `Host`, `Content-Length`, `User-Agent`, `Connection`, `Transfer-Encoding`, and friends.
- 名称、值与宏在保存前校验；值禁止 CR/LF。
  Names, values, and macros are validated before saving; CR/LF is rejected.

## 工作原理 How it works

- 用 `llm/stream` waterfall + `AsyncLocalStorage` 为整条模型流建立作用域。
  An `llm/stream` waterfall plus `AsyncLocalStorage` opens a scope for the whole model stream.
- 通过 `llm-pi-ai/request-headers` 获取真实上游 origin，并注入 pi-ai 系的请求头。
  The real upstream origin comes from `llm-pi-ai/request-headers`, which also carries pi-ai headers.
- 作用域内的 `fetch` 包装器只在该 origin 上改写请求，把该请求交给自带的代理传输。
  Inside the scope, the `fetch` wrapper rewrites only requests to that origin and hands them to the built-in proxy transport.
- `deepseek-official` / `deepseek-account` 不触发上述事件，且一次请求只访问自家 endpoint，因此按整个作用域路由。
  `deepseek-official` / `deepseek-account` do not emit that event and only talk to their own endpoint during one request, so they are routed whole-scope.
- 其余请求（工具、模型发现、鉴权刷新等）完全不受影响。
  Everything else (tools, model discovery, auth refresh) is untouched.
- 代理传输只用 Node 内置模块：CONNECT、absolute-form、SOCKS5/5H、TLS 校验、解压、重定向、AbortSignal、流式 body。
  The proxy transport uses Node built-ins only: CONNECT, absolute-form, SOCKS5/5H, TLS verification, decompression, redirects, AbortSignal, streaming bodies.
- 设置界面通过隐藏锚点 + 结构识别挂载到原生编辑卡；不依赖构建相关的 CSS 类名。
  The settings UI mounts into the native editor card via a hidden anchor plus structural detection, independent of build-specific CSS class names.

## 安全说明 Security notes

- 代理/请求头配置明文保存在 DSH profile 中；请把它当配置而不是密钥库，API Key 仍由 DSH 管理。
  Proxy/header configuration is stored in the DSH profile in plain text; treat it as configuration, not a secret store. DSH keeps managing API keys.
- 代理 URL 支持内嵌凭据，日志中会打码。
  Proxy URLs may embed credentials; they are masked in logs.
- TLS 校验始终开启，没有“忽略证书”开关。
  TLS verification is always on; there is no "ignore certificate" switch.
- 不改 `HTTP_PROXY`/`HTTPS_PROXY`，不安装全局 dispatcher。
  No `HTTP_PROXY`/`HTTPS_PROXY` changes and no global dispatcher.

## 兼容性与边界 Compatibility & limitations

- 仅适用于通过 `globalThis.fetch` 发起模型请求的适配器（pi-ai 系与一方 DeepSeek 适配器）。
  Only adapters that issue model requests through `globalThis.fetch` are covered (pi-ai routes and the first-party DeepSeek adapters).
- 模型发现请求不经过代理。
  Model discovery requests are not proxied.
- 自带 HTTP 栈的第三方 SDK（AWS SDK、gRPC、WebSocket）不会被代理。
  Third-party SDKs with their own HTTP stack (AWS SDK, gRPC, WebSocket) are not proxied.
- 设置界面注入依赖原生编辑器 DOM 形态；DSH 大版本结构调整后可能需要适配。
  The settings UI injection depends on the native editor DOM shape; a future DSH major release may need adaptation.

## 排障 Troubleshooting

- 编辑器里没有这一段：重启 DSH 并强制刷新，然后在 Console 查看 `window.__dshProviderTransport`。
  Section missing from the editor: restart DSH, hard-refresh, then inspect `window.__dshProviderTransport` in the console.
- `anchors = 0`：客户端 bundle 未加载或 Provider 卡片座位未渲染。
  `anchors = 0`: the client bundle did not load, or the provider card seat did not render.
- `anchors > 0, cards = 0`：编辑卡未被识别（`sample` 记录了锚点邻居结构）；`cards` 只在编辑卡打开时大于 0。
  `anchors > 0, cards = 0`: the editor card was not recognized (`sample` records the anchor neighbourhood); `cards` is only non-zero while an editor is open.
- 模型请求报 `Connection error.` / `TRANSPORT` 并重试：请求已被接管，但代理不可达；宿主日志里有 `provider-transport:` 前缀的详细原因。
  Model calls fail with `Connection error.` / `TRANSPORT` and retries: the request was intercepted but the proxy is unreachable; the host log carries a `provider-transport:` line with the cause.
- 需要更详细日志：以 `DSH_PROVIDER_TRANSPORT_DEBUG=1` 启动 DSH。
  Need verbose logs: start DSH with `DSH_PROVIDER_TRANSPORT_DEBUG=1`.

## 测试 Tests

```bash
npm run check        # 语法检查 / syntax check
npm test             # 36 个离线单元/集成测试 / 36 offline unit/integration tests
npm run test:bridge  # 20 项 DOM 桥检查 / 20 DOM-bridge checks
npm run test:smoke   # 加载真实 index.js / loads the real index.js (needs DSH's schemastery)
npm run test:tls     # HTTPS 经 CONNECT/SOCKS5H + 流式增量 / needs openssl
```

TLS 测试会生成一次性自签证书到 `tests/.certs`（已 gitignore）。
TLS tests generate a throwaway self-signed certificate into `tests/.certs` (git-ignored).

## 许可证 License

[MIT](./LICENSE)
