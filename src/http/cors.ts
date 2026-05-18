import type { MiddlewareHandler } from "hono";

export const DEFAULT_CLAUDE_ORIGINS: ReadonlySet<string> = new Set([
  "https://claude.ai",
  "https://api.claude.ai",
  "https://claude.com",
  "https://api.claude.com",
]);

export interface CorsOptions {
  allowedOrigins: ReadonlySet<string>;
  allowedMethods?: string;
  allowedHeaders?: string;
  exposeHeaders?: string;
  maxAgeSeconds?: number;
}

const DEFAULT_METHODS = "GET, POST, OPTIONS";
const DEFAULT_HEADERS = "Content-Type, Authorization, Accept, Mcp-Session-Id";
const DEFAULT_EXPOSE = "WWW-Authenticate";
const DEFAULT_MAX_AGE = 86400;

export function createCors(options: CorsOptions): MiddlewareHandler {
  const allowedMethods = options.allowedMethods ?? DEFAULT_METHODS;
  const allowedHeaders = options.allowedHeaders ?? DEFAULT_HEADERS;
  const exposeHeaders = options.exposeHeaders ?? DEFAULT_EXPOSE;
  const maxAge = String(options.maxAgeSeconds ?? DEFAULT_MAX_AGE);

  return async (c, next) => {
    const origin = c.req.header("Origin");
    const isAllowed = origin !== undefined && options.allowedOrigins.has(origin);

    if (c.req.method === "OPTIONS") {
      if (!isAllowed) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": allowedMethods,
          "Access-Control-Allow-Headers": allowedHeaders,
          "Access-Control-Expose-Headers": exposeHeaders,
          "Access-Control-Max-Age": maxAge,
          Vary: "Origin",
        },
      });
    }

    await next();

    if (isAllowed) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.set("Access-Control-Expose-Headers", exposeHeaders);
      c.res.headers.append("Vary", "Origin");
    }
  };
}
