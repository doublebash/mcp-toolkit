import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { issueBearer, lookupBearer, revokeBearer } from "../../src/oauth/tokens.js";

interface TestEnv {
  TEST_KV: KVNamespace;
}
const testEnv = env as unknown as TestEnv;

async function clearKv() {
  const list = await testEnv.TEST_KV.list();
  await Promise.all(list.keys.map((k) => testEnv.TEST_KV.delete(k.name)));
}

const TTL = 86400;

describe("bearer tokens", () => {
  beforeEach(clearKv);

  it("issues + looks up + revokes", async () => {
    const issued = await issueBearer(testEnv.TEST_KV, { clientId: "client-a", ttlSeconds: TTL });
    expect(issued.rawToken.length).toBeGreaterThan(20);
    const rec = await lookupBearer(testEnv.TEST_KV, issued.rawToken);
    expect(rec?.clientId).toBe("client-a");
    await revokeBearer(testEnv.TEST_KV, issued.rawToken);
    expect(await lookupBearer(testEnv.TEST_KV, issued.rawToken)).toBeNull();
  });

  it("two issuances yield distinct tokens", async () => {
    const a = await issueBearer(testEnv.TEST_KV, { clientId: "a", ttlSeconds: TTL });
    const b = await issueBearer(testEnv.TEST_KV, { clientId: "b", ttlSeconds: TTL });
    expect(a.rawToken).not.toBe(b.rawToken);
  });

  it("does not store the raw token in KV", async () => {
    const { rawToken } = await issueBearer(testEnv.TEST_KV, { clientId: "x", ttlSeconds: TTL });
    const all = await testEnv.TEST_KV.list();
    for (const k of all.keys) {
      expect(k.name.includes(rawToken)).toBe(false);
      const v = await testEnv.TEST_KV.get(k.name);
      expect((v ?? "").includes(rawToken)).toBe(false);
    }
  });

  it("treats expired tokens as missing", async () => {
    const issued = await issueBearer(testEnv.TEST_KV, {
      clientId: "exp",
      ttlSeconds: 3600,
      now: Date.now() - 7200_000,
    });
    expect(await lookupBearer(testEnv.TEST_KV, issued.rawToken)).toBeNull();
  });

  it("returns null on unknown / empty", async () => {
    expect(await lookupBearer(testEnv.TEST_KV, "nope")).toBeNull();
    expect(await lookupBearer(testEnv.TEST_KV, "")).toBeNull();
  });
});
