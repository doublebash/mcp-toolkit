import type { Context, MiddlewareHandler } from "hono";

export interface CloudflareRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

function clientKey(c: Context): string | null {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf;
  return null;
}

function tooManyRequests(): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "60" },
  });
}

export interface CreateRateLimitOptions<Env extends object> {
  binding: (env: Env) => CloudflareRateLimiter | undefined;
  bucketName: string;
  /** If `true`, return 429 instead of falling open when `CF-Connecting-IP` is missing. Default `false`. */
  failOnMissingIp?: boolean;
}

export function createRateLimit<Env extends object>(
  options: CreateRateLimitOptions<Env>,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const limiter = options.binding(c.env);
    if (!limiter) {
      await next();
      return;
    }
    const ip = clientKey(c);
    if (!ip) {
      if (options.failOnMissingIp) return tooManyRequests();
      await next();
      return;
    }
    const key = `${options.bucketName}:${ip}`;
    try {
      const { success } = await limiter.limit({ key });
      if (!success) return tooManyRequests();
    } catch {
      // limiter unavailable — fail open
    }
    await next();
  };
}
