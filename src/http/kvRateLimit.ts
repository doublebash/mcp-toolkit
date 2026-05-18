import type { Context, MiddlewareHandler } from "hono";

export interface KvRateLimitConfig {
  kv: KVNamespace;
  bucket: string;
  limit: number;
  windowSeconds: number;
  failOnMissingIp?: boolean;
}

interface AttemptCheck {
  allowed: boolean;
  attempts: number;
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

export async function checkAttempts(
  config: KvRateLimitConfig,
  ip: string,
): Promise<AttemptCheck> {
  const key = `ratelimit:${config.bucket}:${ip}`;
  const raw = (await config.kv.get(key)) ?? "0";
  const attempts = parseInt(raw, 10);
  if (!Number.isFinite(attempts)) return { allowed: true, attempts: 0 };
  return { allowed: attempts < config.limit, attempts };
}

export async function recordFailure(
  config: KvRateLimitConfig,
  ip: string,
): Promise<void> {
  const key = `ratelimit:${config.bucket}:${ip}`;
  const raw = (await config.kv.get(key)) ?? "0";
  const attempts = parseInt(raw, 10);
  const next = Number.isFinite(attempts) ? attempts + 1 : 1;
  await config.kv.put(key, String(next), { expirationTtl: config.windowSeconds });
}

export async function clearAttempts(
  config: KvRateLimitConfig,
  ip: string,
): Promise<void> {
  const key = `ratelimit:${config.bucket}:${ip}`;
  await config.kv.delete(key);
}

export function createKvRateLimit(config: KvRateLimitConfig): MiddlewareHandler {
  return async (c, next) => {
    const ip = clientKey(c);
    if (!ip) {
      if (config.failOnMissingIp) return tooManyRequests();
      await next();
      return;
    }
    try {
      const { allowed } = await checkAttempts(config, ip);
      if (!allowed) return tooManyRequests();
    } catch {
      // KV unavailable — fail open
    }
    await next();
  };
}
