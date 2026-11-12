# dsh-provider-transport

Per-provider HTTP/HTTPS/SOCKS proxy and custom request headers for **DeepSeek Harness (DSH)** native providers — without replacing credentials, model catalogs, or protocol conversion.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

DSH ships native provider adapters (`llm-pi-ai` multi-provider routes and the first-party `deepseek-official` / `deepseek-account` adapters), but no per-provider transport configuration. This plugin adds one through DSH's own extension points: every model request can use its own proxy and its own set of extra request headers, while DSH keeps owning API keys, model discovery, reasoning options, and streaming.

> Unofficial community plugin. Not affiliated with or endorsed by DeepSeek.

## Features

- **Inside the native provider form.** The proxy/header section is injected into the native *create* and *edit* provider editor. It shares the native **Save / Cancel** buttons — no second save button and no detached settings area.
- **Provider-level and per-model overrides.** A provider default applies to every model; a model may inherit it, opt out, or override the proxy and headers.
- **Proxy modes**
  - `inherit` – keep DSH's native connection;
  - `direct` – explicitly bypass the extension's proxy;
  - `http://` / `https://` – forward proxy (`CONNECT` for TLS destinations, absolute-form for plain HTTP, optional Basic auth);
  - `socks5://` / `socks5h://` – SOCKS5 with local or proxy-side DNS resolution, optional username/password.
- **Custom request headers** with macros `${sessionId}`, `${provider}`, `${model}`, `${purpose}`. Missing dynamic values omit the header instead of sending a placeholder. Per-model headers can add, override, or exclude inherited headers.
- **Live.** Saved settings apply to the next request; no DSH restart for configuration changes.
- **Zero npm runtime dependencies.** Only Node built-ins plus DSH's own `@deepseek-ai/schemastery` (peer dependency, provided by the DSH profile). The proxy transport is implemented from scratch — no `undici` dispatcher, no `socks` package.
- **Safe scoping.** Only the exact model request is rewritten. Tool calls, model discovery, telemetry, and every request outside the model stream keep using the native `fetch` untouched.

## Requirements

- DSH **0.2.2-rc.1** (the extension points below were verified against this build); the Web UI and desktop app both use the web client.
- Node.js **≥ 22** (the DSH runtime).
- A DSH profile (`web` or `desktop`).

No `npm install` is needed: the plugin has no runtime dependencies, and a linked plugin's peer dependencies are resolved from the DSH installation tree.

## Install

```bash
git clone https://github.com/<owner>/dsh-provider-transport.git
cd dsh-provider-transport

# link the source into a profile
dsh plugin --profile web add "$(pwd)"
# restart DSH and refresh the page
```

For the desktop app use `--profile desktop`. Restarting DSH is required because the host plugin and the browser bundle are loaded at boot.

## Usage

1. **Settings → Models**, then expand any provider card and click **Edit** (or start creating one).
2. Inside the native editor you will find **Proxy & Request Headers** before the Cancel/Save row:
   - *Proxy transport*: inherit / no proxy / custom proxy URL;
   - *Custom headers*: name + value rows (values may use macros);
   - *Per-model overrides*: pick a model, then override its proxy, add headers, or exclude inherited ones.
3. Click **Save** once. The plugin writes its namespace first, then lets the native save run; **Cancel** discards both drafts.

Example configuration written to the profile (the UI produces this automatically):

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

### Macros

| Macro | Value |
| --- | --- |
| `${sessionId}` | DSH session id of the request |
| `${provider}` | Native provider id (verbatim) |
| `${model}` | Native model id (verbatim) |
| `${purpose}` | Provider-neutral purpose of the auxiliary call, when present |

A header whose template references a value that is absent for that request is **not sent** (never sent literally or as an empty header).

### Header rules

- Provider headers apply first, then model `removeHeaders` exclusions, then model headers (case-insensitive).
- Headers managed by DSH or the HTTP layer cannot be overridden: `Authorization`, `Proxy-Authorization`, `Host`, `Content-Length`, `User-Agent`, `Connection`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Keep-Alive`, `Proxy-Connection`, `Proxy-Authenticate`, `Expect`.
- Header values are validated (token names, no CR/LF, no unsupported macros) before saving.

## How it works

| Capability | DSH extension point |
| --- | --- |
| Detect the exact model request (provider/model/session/purpose) | `llm/stream` waterfall (`{ global: true, prepend: true }`) wrapped in an `AsyncLocalStorage` scope |
| Learn the real upstream endpoint origin | `llm-pi-ai/request-headers` waterfall (`request.baseURL`) |
| Inject headers | The official header waterfall for pi-ai providers; the scoped `fetch` wrapper as fallback for adapters that do not emit that event |
| Route the request through a proxy | The scoped `fetch` wrapper hands that one request to the built-in transport |
| Edit configuration | `provider-transport` settings namespace, `remote.settings.describe/mutate` with revision conflict detection |
| Place the UI | Hidden anchor in the `settings.models.provider-card` keyed slot; fields are mounted into the native provider editor card, sharing its submit button |

**Scoping.** `llm/stream` opens an `AsyncLocalStorage` scope for the whole model stream, including async-generator pulls. The `fetch` wrapper only rewrites a request when that scope is active **and** the request URL matches the provider endpoint origin reported by `llm-pi-ai/request-headers`. The first-party `deepseek-official` / `deepseek-account` adapters do not emit that event and only talk to their own endpoint during one model request, so they are routed whole-scope. Everything else — tool requests, model discovery, OAuth/refresh calls — stays on the native `fetch`.

**Proxy transport** (`transport.js`, Node built-ins only):

- HTTPS destinations through an HTTP(S) proxy use `CONNECT`, then a verified TLS handshake (SNI + certificate chain, no insecure switch);
- plain HTTP destinations use absolute-form forwarding;
- SOCKS5 / SOCKS5H handshake with optional username/password;
- streaming responses are returned as a real WHATWG `Response` with a `ReadableStream` body, so SSE diff streams stay incremental;
- `content-encoding` (`gzip`, `deflate`, `br`, `zstd`) is decoded while streaming;
- redirects, `AbortSignal`, and `Response.url`/`redirected` behave like `fetch`.

**UI bridge.** The native provider editor has no plugin slot, so the client bundle renders a hidden anchor in the provider card seat, then finds the native editor card next to that anchor *by structure* (it contains form controls and ends in an action row with at least two buttons — no build-specific CSS class names). It mounts the fields before that action row and intercepts the native submit button in the capture phase: save the transport namespace, then let the native save continue. Cancel simply drops the draft. If DSH changes that DOM shape, the bridge does nothing instead of guessing.

## Security notes

- Proxy/header configuration lives in the DSH **profile configuration file in plain text**. Treat header values as configuration, not as a secret store; DSH keeps API keys in its own credential storage and this plugin cannot read or replace them.
- Header values appear in the settings UI and in the profile file; proxy credentials are supported in proxy URLs and are masked in host logs.
- TLS certificate verification is always on. There is no "ignore certificate errors" switch.
- The plugin never modifies `HTTP_PROXY` / `HTTPS_PROXY` environment variables or installs a global dispatcher: only the scoped model request is affected.

## Compatibility & limitations

- Works for adapters that issue model requests through `globalThis.fetch` — the pi-ai routes and the first-party DeepSeek adapters. A third-party SDK with its own HTTP stack (AWS SDK, gRPC, WebSocket transports) will not be proxied; its non-header transport cannot be intercepted from a plugin.
- Model discovery (`/models` listings) happens outside the inference scope and is not proxied.
- The settings UI injection is DOM-based (DSH 0.2.2-rc.1 has no provider-editor slot). A future DSH major version may change that DOM; the bridge then stays inert. Diagnostics: `window.__dshProviderTransport`.
- Proxy support targets HTTP/1.1 endpoints, which is what the LLM providers expose.
- DSH desktop and web both use the same web client bundle.

## Troubleshooting

| Symptom | Meaning / fix |
| --- | --- |
| The section is missing from the editor | DSH has not loaded the client bundle yet: restart DSH and hard-refresh. Then check `window.__dshProviderTransport`: `anchors = 0` means the provider card seat did not render; `anchors > 0, cards = 0` means the editor card was not recognized (compare `sample` with the DOM). `cards` is only non-zero while an editor card is open. |
| "provider-transport settings namespace unavailable" | The host plugin did not load. Check the profile bundles contain `dsh-provider-transport`, then restart DSH. |
| Model calls fail with `Connection error.` / `TRANSPORT` and retries | The request was intercepted but the configured proxy is unreachable. This is expected for a dead proxy. The host log has a `provider-transport:` line with provider, model, proxy (credentials masked), request URL and cause. |
| Headers do not show up upstream | Verify the provider uses the pi-ai adapter (`llm-pi-ai/request-headers` path) or one of the first-party DeepSeek adapters; custom headers cannot override reserved headers. |

## Tests

```bash
npm run check        # syntax check of all host/client sources
npm test             # 36 unit/integration tests (no network, no DSH required)
npm run test:bridge  # 20 DOM-bridge checks against the real client bundle
npm run test:smoke   # loads the real index.js with a fake DSH context (needs DSH's schemastery)
npm run test:tls     # HTTPS through CONNECT / SOCKS5H + streaming (needs openssl)
```

`npm test` starts loopback HTTP targets, an HTTP forward proxy (absolute-form + `CONNECT`) and a SOCKS5 server, then exercises the transport end to end: absolute-form requests, proxy auth, SOCKS5/5H, local vs remote DNS, gzip decoding, incremental streaming, abort, redirects, 204, multiple `Set-Cookie` headers, and error paths. TLS tests generate a throwaway self-signed certificate (`tests/.certs`, git-ignored). CI runs all of the above on Linux with Node 22/24.

## License

[MIT](./LICENSE)
