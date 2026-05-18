# @bashco/mcp-toolkit

A small, focused library for building OAuth-compliant **Model Context Protocol (MCP)** servers on **Cloudflare Workers**.

It handles the security-critical plumbing — per-client bearer tokens, OAuth 2.0 + PKCE, rate limiting, structured logging, typed tool dispatch, upstream API clients — so your MCP server code stays focused on the tools you actually want to expose.

## Status

`v1.0.0` — production. Used by four published MCP servers (GoHighLevel, Xero, Microsoft Outlook, Aryeo) that together run on a real workload. 40 internal tests, security-reviewed before each release.

## Install

```bash
npm install @bashco/mcp-toolkit
```

You also need the two peer dependencies:

```bash
npm install hono@^4.12.15 zod@^4.3.6
```

## Minimal example

```ts
import { Hono } from "hono";
import { z } from "zod";
import {
  createOAuthServer,
  createBearerMiddleware,
  createMcpRouter,
  defineTools,
  ToolError,
} from "@bashco/mcp-toolkit";

type Env = {
  OAUTH_KV: KVNamespace;
  MCP_APPROVAL_CODE: string;
  // ...your upstream API key / tokens go here
};

// 1. Define your tools with Zod schemas.
const tools = defineTools({
  hello_world: {
    description: "Say hello to a name.",
    schema: z.object({ name: z.string() }),
    handler: async ({ name }) => ({ greeting: `Hello, ${name}!` }),
  },
});

// 2. Wire up the OAuth + MCP server.
const app = new Hono<{ Bindings: Env }>();

const oauth = createOAuthServer({
  serverName: "Hello MCP",
  kv: (env) => env.OAUTH_KV,
  approvalCode: (env) => env.MCP_APPROVAL_CODE,
});
app.route("/", oauth.router);

app.use("/mcp/*", createBearerMiddleware({ kv: (env) => env.OAUTH_KV }));
app.route("/mcp", createMcpRouter({ tools }));

export default app;
```

That's a complete MCP server — OAuth flow, per-client bearer tokens, tool dispatch, error handling, all wired through the toolkit.

## Modules

The toolkit is organised into small, independently-importable modules:

| Subpath | What it provides |
| --- | --- |
| `@bashco/mcp-toolkit/oauth` | OAuth 2.0 + PKCE server, per-client KV-stored bearer tokens, approval-code gating |
| `@bashco/mcp-toolkit/http` | MCP JSON-RPC router, CORS for Claude origins, HTML approve page, native + KV-based rate limiting |
| `@bashco/mcp-toolkit/tools` | Type-safe Zod tool definition + dispatch |
| `@bashco/mcp-toolkit/errors` | `ToolError` for structured tool error returns |
| `@bashco/mcp-toolkit/crypto` | Timing-safe compare, base64url, SHA-256, AES-GCM encrypt-at-rest |
| `@bashco/mcp-toolkit/ids` | UUID and provider-id validators, path-template builder |
| `@bashco/mcp-toolkit/log` | Single-line JSON structured logger |
| `@bashco/mcp-toolkit/upstreamAuth` | Static API-token header helper, proxied upstream OAuth token store (encrypted at rest) |
| `@bashco/mcp-toolkit/upstreamClient` | Fetch wrapper for the upstream API: retries, timeouts, structured errors |
| `@bashco/mcp-toolkit/testing` | Vitest config helper for `@cloudflare/vitest-pool-workers` |

You can also do `import { ... } from "@bashco/mcp-toolkit"` to pull from the root, or import the subpaths directly for smaller bundles.

## Requirements

- **Cloudflare Workers** runtime (the toolkit uses `KVNamespace`, the Workers Fetch API, and standard Web Crypto)
- **Hono** `^4.12.15` (peer dependency — install in your project)
- **Zod** `^4.3.6` (peer dependency)
- **TypeScript** `^5.7` recommended (the toolkit ships TS source via the `exports` map; your project's bundler — `wrangler`, `esbuild`, `vite`, etc. — transpiles it as it would any other TS dep)

## Reference implementations

Four production MCP servers built on this toolkit. Fork any of them to deploy your own copy, or read the source as worked examples of how the toolkit pieces fit together:

- [`doublebash/ghl-mcp`](https://github.com/doublebash/ghl-mcp) — GoHighLevel CRM (static API-token auth)
- [`doublebash/xero-mcp`](https://github.com/doublebash/xero-mcp) — Xero accounting (proxied OAuth)
- [`doublebash/outlook-mcp`](https://github.com/doublebash/outlook-mcp) — Microsoft Outlook + Calendar + Tasks (proxied OAuth, 28 tools across 6 domains)
- [`doublebash/aryeo-mcp`](https://github.com/doublebash/aryeo-mcp) — Aryeo real-estate media platform (static API-token auth)

## Development

```bash
git clone https://github.com/doublebash/mcp-toolkit
cd mcp-toolkit
npm install
npm run typecheck
npm test
```

The test suite uses `@cloudflare/vitest-pool-workers` to run against a real Workers runtime (miniflare). A folder path containing `&` will break the test runner — keep the clone in a path without that character.

## Contributing

Issues and PRs welcome at [github.com/doublebash/mcp-toolkit](https://github.com/doublebash/mcp-toolkit). Please open an issue before sending a large PR so we can discuss the approach.

## License

[MIT](./LICENSE) — Copyright (c) 2026 Bashar Basheer.
