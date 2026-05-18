import type { MiddlewareHandler } from "hono";
import { lookupBearer } from "./tokens.js";

export interface BearerMiddlewareOptions {
  /** KV namespace where `bearer:<sha256(token)>` records live. */
  kv: (env: unknown) => KVNamespace;
  /** Pathnames that should bypass the bearer check (e.g. /authorize, /token, /.well-known/*). */
  publicPaths: ReadonlySet<string>;
  /** Realm string surfaced in the WWW-Authenticate header. */
  realm: string;
}

declare module "hono" {
  interface ContextVariableMap {
    clientId: string;
  }
}

export function createBearerMiddleware(options: BearerMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (options.publicPaths.has(url.pathname)) return next();

    const auth = c.req.header("Authorization") ?? "";
    const prefix = "Bearer ";
    const raw = auth.startsWith(prefix) ? auth.slice(prefix.length).trim() : "";
    if (!raw) return unauthorized(url.origin, options.realm);

    const record = await lookupBearer(options.kv(c.env), raw);
    if (!record) return unauthorized(url.origin, options.realm);

    c.set("clientId", record.clientId);
    return next();
  };
}

function unauthorized(base: string, realm: string): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="${realm}", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    },
  });
}
