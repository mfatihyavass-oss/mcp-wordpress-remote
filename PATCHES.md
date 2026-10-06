# Local patch series (Maya Hukuk fork)

This checkout is a patched copy of `@automattic/mcp-wordpress-remote` (MIT, Automattic Inc.).
The patches below are NOT in upstream; see "Upstream status" per entry.

## 0.4.1 — session-bound `MCP-Protocol-Version` header

**Problem.** The proxy sent a hard-coded `MCP-Protocol-Version: 2025-06-18` on every HTTP
request to the WordPress MCP endpoint (`src/lib/wordpress-api.ts`). WordPress' MCP Adapter
binds an HTTP session to the protocol version negotiated during `initialize` (2025-11-25 for
current MCP clients) and answers a request whose header disagrees with HTTP 400 /
JSON-RPC -32600 `Invalid Request: MCP-Protocol-Version must be 2025-11-25 for this session`.
Every tool call through the proxy therefore failed while the same endpoint answered a direct
HTTP MCP client normally.

**Fix.**

- `src/lib/wordpress-api.ts`: the negotiated version is captured from the `initialize`
  response (`captureProtocolVersion`) and repeated in the header of all follow-up requests.
  During `initialize` itself the client's requested version is echoed — read from
  `params.protocolVersion` (JSON-RPC) or the top level (simple transport), falling back to the
  SDK's `LATEST_PROTOCOL_VERSION` when the client sent none. When the server reports no
  version at all, follow-up requests fall back to the version the client requested on its last
  `initialize` before `LATEST_PROTOCOL_VERSION`, so an older client is not silently upgraded. A
  fresh `initialize` clears the stored version so a server that reports none cannot leave a
  stale value behind. A
  user-supplied `CUSTOM_HEADERS` override still wins (merged last, unchanged).
- `src/proxy.ts`: the version returned to the MCP client falls back to the client's requested
  version before the legacy `2025-06-18` constant, so client and session agree.

**Upstream status.** Not fixed as of upstream `main` (`src/lib/wordpress-api.ts` still
hard-codes `'2025-06-18'`); latest published release is 0.4.0.

**Note on the version bump.** Per upstream `AGENTS.md`, `package.json` and
`MCP_WORDPRESS_REMOTE_VERSION` move together; the token store is namespaced by version, so
OAuth users re-authenticate once. This deployment uses Basic auth (`OAUTH_ENABLED=false`), so
the bump is a no-op here — it only keeps the running build identifiable.
