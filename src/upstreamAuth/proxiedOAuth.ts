import { z } from "zod";
import { decryptAtRest, encryptAtRest } from "../crypto/encryption.js";
import { log } from "../log/log.js";

const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_LOCK_TTL_S = 60;
const DEFAULT_REFRESH_LOCK_BACKOFF_MS = 200;
const DEFAULT_REFRESH_LOCK_MAX_ATTEMPTS = 25;

export const tokenDataSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_at: z.number().int().nonnegative(),
  })
  .passthrough();

export type TokenData = z.infer<typeof tokenDataSchema>;

export interface ProxiedOAuthStoreOptions {
  /** KV namespace handle. */
  kv: KVNamespace;
  /** KV key where encrypted token JSON is stored (e.g. 'xero_tokens'). */
  tokensKey: string;
  /** Secret used to derive the AES-GCM key. The CALLER is responsible for choosing a long-lived one. */
  encryptionSecret: string;
  /** Namespace for HKDF salt — keeps per-server keys distinct (e.g. 'xero-mcp-v1'). */
  encryptionNamespace: string;
  /** Endpoint to call for `grant_type=refresh_token`. */
  refreshEndpoint: string;
  /** Builds the refresh-request body. */
  refreshBody: (refreshToken: string) => URLSearchParams | Record<string, string>;
  /** Optional extra headers (e.g. Basic auth header for confidential clients). */
  refreshHeaders?: () => Record<string, string>;
  /** How early to refresh before the token expires. Default 5 min. */
  refreshSkewMs?: number;
  /** TTL (s) of the KV-backed refresh lock. Default 60s. */
  refreshLockTtlSeconds?: number;
  /** Backoff (ms) between lock-acquisition retries. Default 200ms. */
  refreshLockBackoffMs?: number;
  /** Max lock-acquisition attempts. Default 25 (~5s). */
  refreshLockMaxAttempts?: number;
  /** Optional callback to revoke the upstream refresh token (e.g. RFC 7009 /revoke). */
  revokeUpstream?: (refreshToken: string) => Promise<void>;
}

export interface ProxiedOAuthStore {
  saveTokens(tokens: TokenData): Promise<void>;
  getTokens(): Promise<TokenData | null>;
  getValidAccessToken(): Promise<string>;
  clearTokens(): Promise<void>;
}

function lockKey(tokensKey: string): string {
  return `${tokensKey}:refresh-lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createProxiedOAuthStore(options: ProxiedOAuthStoreOptions): ProxiedOAuthStore {
  const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const lockTtl = options.refreshLockTtlSeconds ?? DEFAULT_REFRESH_LOCK_TTL_S;
  const lockBackoff = options.refreshLockBackoffMs ?? DEFAULT_REFRESH_LOCK_BACKOFF_MS;
  const lockMaxAttempts = options.refreshLockMaxAttempts ?? DEFAULT_REFRESH_LOCK_MAX_ATTEMPTS;
  const REFRESH_LOCK_KEY = lockKey(options.tokensKey);

  async function saveTokens(tokens: TokenData): Promise<void> {
    const ciphertext = await encryptAtRest(
      JSON.stringify(tokens),
      options.encryptionSecret,
      options.encryptionNamespace,
    );
    await options.kv.put(options.tokensKey, ciphertext);
  }

  async function getTokens(): Promise<TokenData | null> {
    const raw = await options.kv.get(options.tokensKey);
    if (!raw) return null;
    try {
      const plaintext = await decryptAtRest(raw, options.encryptionSecret, options.encryptionNamespace);
      const parsed = tokenDataSchema.safeParse(JSON.parse(plaintext));
      if (!parsed.success) {
        await options.kv.delete(options.tokensKey).catch(() => {});
        return null;
      }
      return parsed.data;
    } catch {
      await options.kv.delete(options.tokensKey).catch(() => {});
      return null;
    }
  }

  async function clearTokens(): Promise<void> {
    const existing = await getTokens();
    if (existing && options.revokeUpstream) {
      try {
        await options.revokeUpstream(existing.refresh_token);
      } catch {
        // best-effort
      }
    }
    await options.kv.delete(options.tokensKey).catch(() => {});
  }

  async function acquireLock(token: string): Promise<boolean> {
    const existing = await options.kv.get(REFRESH_LOCK_KEY);
    if (existing) return false;
    await options.kv.put(REFRESH_LOCK_KEY, token, { expirationTtl: lockTtl });
    // Verify-after-put: read it back to confirm we own it (best-effort CAS on last-write-wins KV).
    const confirmed = await options.kv.get(REFRESH_LOCK_KEY);
    return confirmed === token;
  }

  async function releaseLock(token: string): Promise<void> {
    const existing = await options.kv.get(REFRESH_LOCK_KEY);
    if (existing === token) {
      await options.kv.delete(REFRESH_LOCK_KEY).catch(() => {});
    }
  }

  async function performRefresh(current: TokenData): Promise<TokenData> {
    const bodyInput = options.refreshBody(current.refresh_token);
    const body =
      bodyInput instanceof URLSearchParams
        ? bodyInput
        : new URLSearchParams(bodyInput);
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(options.refreshHeaders ? options.refreshHeaders() : {}),
    };
    const response = await fetch(options.refreshEndpoint, {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) {
      throw new Error(`token refresh failed: ${response.status}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const accessToken = data["access_token"];
    if (typeof accessToken !== "string") {
      throw new Error("token refresh: missing access_token");
    }
    const newRefreshToken =
      typeof data["refresh_token"] === "string" && (data["refresh_token"] as string).length > 0
        ? (data["refresh_token"] as string)
        : current.refresh_token;
    const expiresInRaw = data["expires_in"];
    const expiresIn = typeof expiresInRaw === "number" ? expiresInRaw : 1800;
    const next: TokenData = {
      ...current,
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_at: Date.now() + expiresIn * 1000,
    };
    await saveTokens(next);
    return next;
  }

  async function getValidAccessToken(): Promise<string> {
    const tokens = await getTokens();
    if (!tokens) throw new Error("upstream not authenticated");

    if (Date.now() < tokens.expires_at - refreshSkewMs) {
      return tokens.access_token;
    }

    const lockToken = crypto.randomUUID();
    let attempts = 0;
    while (attempts < lockMaxAttempts) {
      if (await acquireLock(lockToken)) {
        try {
          const fresh = await getTokens();
          if (!fresh) throw new Error("upstream not authenticated");
          if (Date.now() < fresh.expires_at - refreshSkewMs) {
            return fresh.access_token;
          }
          const refreshed = await performRefresh(fresh);
          return refreshed.access_token;
        } finally {
          await releaseLock(lockToken);
        }
      }
      attempts += 1;
      await sleep(lockBackoff);
      const polled = await getTokens();
      if (polled && Date.now() < polled.expires_at - refreshSkewMs) {
        return polled.access_token;
      }
    }
    log.warn("refresh_lock_timeout", { tokensKey: options.tokensKey, attempts });
    throw new Error("token refresh: could not acquire lock");
  }

  return { saveTokens, getTokens, getValidAccessToken, clearTokens };
}
