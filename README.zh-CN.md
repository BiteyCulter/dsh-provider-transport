# dsh-provider-transport

为 **DeepSeek Harness (DSH)** 原生 Provider 增加**按 Provider / 按 Model 的 HTTP(S)/SOCKS 代理**与**自定义请求头**，不替换凭据、模型目录或协议转换。

[English README](./README.md) · [MIT License](./LICENSE)

DSH 自带 `llm-pi-ai` 多 Provider 适配器，以及 `deepseek-official` / `deepseek-account` 一方适配器，但不提供按 Provider 的传输配置。本插件通过 DSH 官方扩展点补上这一层：每次模型请求都可以使用自己的代理和一组额外的请求头，而 API Key、模型发现、推理选项和流式处理仍然由 DSH 负责。

> 非官方社区插件，与 DeepSeek 无隶属或背书关系。

## 功能

- **就在原生 Provider 表单里。** 代理/请求头区域注入原生**创建**和**编辑**卡片，与原生字段共用同一个**保存 / 取消**按钮，没有第二套保存逻辑，也没有独立的设置区域。
- **Provider 级 + Model 级覆盖。** Provider 默认作用于其所有模型；单个模型可继承、跳过或覆盖代理与请求头。
- **代理模式**
  - `inherit`：沿用 DSH 原生连接；
  - `direct`：明确不使用本插件的代理；
  - `http://` / `https://`：HTTP 代理（HTTPS 目标走 `CONNECT`，HTTP 目标走 absolute-form，可选 Basic 认证）；
  - `socks5://` / `socks5h://`：SOCKS5，本地或代理端解析域名，可选用户名密码。
- **自定义请求头**，支持宏 `${sessionId}`、`${provider}`、`${model}`、`${purpose}`；动态值缺失时**不发送**该请求头（不会发出字面量或空值）。Model 级可新增、覆盖或排除继承的请求头。
- **实时生效**：保存后下一次请求即使用新配置，配置变更无需重启 DSH。
- **零 npm 运行时依赖**：只用 Node 内置模块 + DSH 自带的 `@deepseek-ai/schemastery`（peer dependency，由 DSH profile 提供）。代理传输为自己实现，不依赖 `undici` dispatcher 或 `socks` 包。
- **严格作用域**：只改写当前这一次模型请求。工具调用、模型发现、遥测以及模型流之外的所有请求仍然走原生 `fetch`。

## 环境要求

- DSH **0.2.2-rc.1**（下述扩展点已在该构建上验证；Web 与 Desktop 共用同一套 Web 客户端）。
- Node.js **≥ 22**（DSH 运行时）。
- 一个 DSH profile（`web` 或 `desktop`）。

不需要 `npm install`：插件没有运行时依赖，linked 插件的 peer 依赖由 DSH 安装树解析。

## 安装

```bash
git clone https://github.com/<owner>/dsh-provider-transport.git
cd dsh-provider-transport

# 把源码链接进 profile
dsh plugin --profile web add "$(pwd)"
# 重启 DSH 并刷新页面
```

Desktop 版把 `web` 换成 `desktop`。必须重启 DSH：宿主插件和浏览器 bundle 都在启动时加载。

## 使用

1. **设置 → 模型**，展开任一 Provider 卡片，点 **编辑**（或开始创建）。
2. 原生编辑器里、取消/保存按钮之前会出现 **网络代理与请求头**：
   - *Proxy 传输*：继承 / 不使用代理 / 指定代理地址；
   - *自定义请求头*：名称 + 值（值可用宏）；
   - *按 Model 覆盖*：选择模型后覆盖其代理、添加请求头或排除继承项。
3. 点一次 **保存**：插件先写入自己的命名空间，再放行原生保存；**取消**则两边草稿一起丢弃。

界面最终写入 profile 的配置形如：

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

### 宏

| 宏 | 取值 |
| --- | --- |
| `${sessionId}` | 该请求所属 DSH 会话 id |
| `${provider}` | 原生 provider id（原样） |
| `${model}` | 原生 model id（原样） |
| `${purpose}` | 辅助调用的用途（存在时） |

引用了当前请求缺失值的模板**不会发送**。

### 请求头规则

- 合并顺序：Provider 默认 → Model `removeHeaders` 排除 → Model 覆盖/新增（名称大小写不敏感）。
- 由 DSH 或 HTTP 层管理的头不能覆盖：`Authorization`、`Proxy-Authorization`、`Host`、`Content-Length`、`User-Agent`、`Connection`、`Transfer-Encoding`、`TE`、`Trailer`、`Upgrade`、`Keep-Alive`、`Proxy-Connection`、`Proxy-Authenticate`、`Expect`。
- 保存前会校验名称、值（禁止 CR/LF）与未知宏。

## 工作原理

| 能力 | DSH 扩展点 |
| --- | --- |
| 定位一次模型请求（provider/model/session/purpose） | `llm/stream` waterfall（`{ global: true, prepend: true }`），用 `AsyncLocalStorage` 包住整条流 |
| 获取上游真实 endpoint origin | `llm-pi-ai/request-headers` waterfall 的 `request.baseURL` |
| 注入请求头 | pi-ai 系走官方 header waterfall；不触发该事件的适配器由作用域内 `fetch` 兜底 |
| 代理路由 | 作用域内替换 `globalThis.fetch`，把该请求交给自带传输 |
| 配置读写 | `provider-transport` settings namespace + `remote.settings.describe/mutate`（带 revision 冲突检测） |
| 界面挂载 | `settings.models.provider-card` keyed 座位放隐藏锚点；字段注入原生编辑卡并与原生提交按钮共用保存 |

**作用域**：`llm/stream` 为整条模型流（包括异步生成器每次 pull）打开 `AsyncLocalStorage` 作用域。`fetch` 包装器只在作用域内、且请求 URL 命中 `llm-pi-ai/request-headers` 给出的 endpoint origin 时改写请求。一方 `deepseek-official` / `deepseek-account` 不触发该事件，且一次模型请求内只访问自家 endpoint，因此按整个作用域路由。其余请求（工具、模型发现、鉴权刷新等）完全不动。

**代理传输**（`transport.js`，仅 Node 内置模块）：

- HTTPS 目标经 HTTP(S) 代理：`CONNECT` + 标准 TLS 校验（SNI + 证书链，没有“忽略证书”开关）；
- HTTP 目标：absolute-form 转发；
- `socks5://` 本地解析域名，`socks5h://` 交给代理解析，支持用户名密码；
- 响应被包装成标准 `Response`（流式 body），SSE diff 流保持增量；
- 自动解码 `gzip` / `deflate` / `br` / `zstd`；
- 支持重定向、`AbortSignal`、`Response.url` / `redirected`。

**界面桥**：DSH 0.2.2-rc.1 的 Provider 编辑器没有插件插槽，所以客户端渲染隐藏锚点后，**按结构**（包含表单控件、末尾是至少两个按钮的操作行，不依赖构建相关的 CSS 类名）找到旁边（允许一层包装）的原生编辑卡，把字段插到操作行之前，并在捕获阶段拦截原生提交按钮：先保存 transport 命名空间，再放行原生保存；取消则丢弃草稿。若 DSH 修改了 DOM 结构，桥会保持静默而不是误注入。

## 安全说明

- 代理/请求头配置以**明文**存放在 DSH profile 配置文件中。请把它当配置而不是密钥库；API Key 仍由 DSH 自己的凭据存储管理，本插件不读取也不替换。
- 请求头值会出现在设置界面与 profile 文件中；代理 URL 支持内嵌凭据，日志中会被打码。
- TLS 校验始终开启，没有关闭校验的选项。
- 插件不会修改 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，也不会安装全局 dispatcher：只影响作用域内的那一次模型请求。

## 兼容性与边界

- 适用于通过 `globalThis.fetch` 发起模型请求的适配器：pi-ai 系与一方 DeepSeek 适配器。自带 HTTP 栈的第三方 SDK（AWS SDK、gRPC、WebSocket 等）不会被代理。
- 模型发现（`/models`）发生在推理作用域之外，不经过代理。
- 设置界面注入依赖原生编辑器 DOM 形态；未来 DSH 大版本若改变结构，桥可能失效。诊断入口：`window.__dshProviderTransport`。
- 代理实现目标是 HTTP/1.1 endpoint（各 LLM Provider 的实际形态）。

## 排障

| 现象 | 含义 / 处理 |
| --- | --- |
| 编辑器里没有这一段 | 客户端 bundle 未加载：重启 DSH 并强制刷新。然后在 Console 查看 `window.__dshProviderTransport`：`anchors = 0` 表示 Provider 卡片座位未渲染；`anchors > 0, cards = 0` 表示编辑卡未被识别（对照 `sample` 看 DOM）。`cards` 只在编辑卡打开时大于 0。 |
| 「provider-transport 设置命名空间不可用」 | 宿主插件未加载：确认 profile bundles 含 `dsh-provider-transport`，重启 DSH。 |
| 模型请求报 `Connection error.` / `TRANSPORT` 并重试 | 请求已被接管，但配置的代理不可达（测试死端口时属于预期）。宿主日志中有 `provider-transport:` 前缀的记录，包含 provider、model、打码后的代理地址、请求 URL 与原因。 |
| 需要更详细的传输日志 | 用 `DSH_PROVIDER_TRANSPORT_DEBUG=1` 启动 DSH，宿主日志会记录每一步（目标、代理分支、TLS 握手、响应）。 |
| 上游看不到自定义请求头 | 确认该 Provider 走 pi-ai 适配器或一方 DeepSeek 适配器；保留头不能被覆盖。 |

## 测试

```bash
npm run check        # 语法检查
npm test             # 36 个单元/集成测试（离线，不需要 DSH）
npm run test:bridge  # 20 项 DOM 桥检查（直接跑真实 client.js）
npm run test:smoke   # 用假 DSH ctx 加载真实 index.js（需要 DSH 的 schemastery）
npm run test:tls     # HTTPS 经 CONNECT / SOCKS5H + 流式增量（需要 openssl）
```

`npm test` 会起本地环回 HTTP 目标、HTTP forward proxy（absolute-form + `CONNECT`）与 SOCKS5 服务器，端到端覆盖：转发、代理认证、SOCKS5/5H、本地/远程 DNS、gzip 解码、流式增量、取消、重定向、204、多个 `Set-Cookie` 以及错误路径。TLS 测试生成一次性自签证书（`tests/.certs`，已 gitignore）。CI 在 Linux + Node 22/24 上运行上述全部测试。

## License

[MIT](./LICENSE)
