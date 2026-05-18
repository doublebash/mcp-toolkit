import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProxiedOAuthStore,
  type TokenData,
} from "../../src/upstreamAuth/proxiedOAuth.js";

interface TestEnv {
  TEST_KV: KVNamespace;
}
const testEnv = env as unknown as TestEnv;

async function clearKv() {
  const list = await testEnv.TEST_KV.list();
  await Promise.all(list.keys.map((k) => testEnv.TEST_KV.delete(k.name)));
}

function makeStore(overrides?: Partial<Parameters<typeof createProxiedOAuthStore>[0]>) {
  return createProxiedOAuthStore({
    kv: testEnv.TEST_KV,
    tokensKey: "test_tokens",
    encryptionSecret: "test-secret-32-bytes-or-more-ok-here",
    encryptionNamespace: "test-ns-v1",
    refreshEndpoint: "https://refresh.example/token",
    refreshBody: (rt) => ({ grant_type: "refresh_token", refresh_token: rt }),
    refreshLockBackoffMs: 10,
    refreshLockMaxAttempts: 5,
    ...overrides,
  });
}

const NOW = Date.now();
const fresh: TokenData = {
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_at: NOW + 3600_000,
};
const expired: TokenData = {
  access_token: "at-old",
  refresh_token: "rt-old",
  expires_at: NOW - 60_000,
};

describe("proxiedOAuthStore", () => {
  beforeEach(async () => {
    await clearKv();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encrypts tokens at rest and decrypts on read", async () => {
    const store = makeStore();
    await store.saveTokens(fresh);
    const raw = await testEnv.TEST_KV.get("test_tokens");
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("at-1"); // ciphertext shouldn't contain the plaintext access token
    const loaded = await store.getTokens();
    expect(loaded?.access_token).toBe("at-1");
  });

  it("returns null + clears KV if decryption fails (e.g. secret rotated)", async () => {
    const a = makeStore({ encryptionSecret: "secret-a" });
    await a.saveTokens(fresh);
    const b = makeStore({ encryptionSecret: "secret-b" });
    const result = await b.getTokens();
    expect(result).toBeNull();
    expect(await testEnv.TEST_KV.get("test_tokens")).toBeNull();
  });

  it("returns the cached access_token when it isn't near expiry", async () => {
    const store = makeStore();
    await store.saveTokens(fresh);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const token = await store.getValidAccessToken();
    expect(token).toBe("at-1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes when the token is near expiry", async () => {
    const store = makeStore();
    await store.saveTokens(expired);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 1800 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const token = await store.getValidAccessToken();
    expect(token).toBe("at-2");
    const after = await store.getTokens();
    expect(after?.refresh_token).toBe("rt-2");
  });

  it("falls back to existing refresh_token if upstream omits it", async () => {
    const store = makeStore();
    await store.saveTokens(expired);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "at-2", expires_in: 1800 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await store.getValidAccessToken();
    const after = await store.getTokens();
    expect(after?.refresh_token).toBe("rt-old"); // kept the existing one
  });

  it("clearTokens calls revokeUpstream if provided and deletes KV", async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const store = makeStore({ revokeUpstream: revoke });
    await store.saveTokens(fresh);
    await store.clearTokens();
    expect(revoke).toHaveBeenCalledWith("rt-1");
    expect(await testEnv.TEST_KV.get("test_tokens")).toBeNull();
  });

  it("throws if no tokens are present", async () => {
    const store = makeStore();
    await expect(store.getValidAccessToken()).rejects.toThrow();
  });
});
