import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Base64Url } from "../../src/crypto/encoding.js";
import { createBearerMiddleware } from "../../src/oauth/middleware.js";
import { createOAuthServer, OAUTH_PUBLIC_PATHS } from "../../src/oauth/server.js";
import { lookupBearer } from "../../src/oauth/tokens.js";

interface TestEnv {
  TEST_KV: KVNamespace;
}
const testEnv = env as unknown as TestEnv;

async function clearKv() {
  const list = await testEnv.TEST_KV.list();
  await Promise.all(list.keys.map((k) => testEnv.TEST_KV.delete(k.name)));
}

function makeApp() {
  const { routes } = createOAuthServer<TestEnv & object>({
    serverName: "Test MCP",
    approvalCodeName: "TEST_APPROVAL",
    kv: (e) => e.TEST_KV,
    approvalCodeSecret: () => "the-approval-code",
    allowedRedirectHosts: new Set(["claude.ai"]),
  });
  const app = new Hono<{ Bindings: TestEnv }>();
  app.use(
    "*",
    createBearerMiddleware({
      kv: (e) => (e as TestEnv).TEST_KV,
      publicPaths: OAUTH_PUBLIC_PATHS,
      realm: "Test MCP",
    }),
  );
  app.route("/", routes);
  app.get("/private", (c) => c.json({ ok: true, clientId: c.get("clientId") }));
  return app;
}

async function pkce() {
  const verifier = "x".repeat(64);
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

describe("createOAuthServer end-to-end", () => {
  beforeEach(clearKv);

  it("advertises authorization_code only", async () => {
    const res = await makeApp().fetch(
      new Request("https://x.test/.well-known/oauth-authorization-server"),
      testEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.grant_types_supported).toEqual(["authorization_code"]);
  });

  it("rejects non-S256 challenge methods", async () => {
    const url = new URL("https://x.test/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "c");
    url.searchParams.set("redirect_uri", "https://claude.ai/cb");
    url.searchParams.set("code_challenge", "abc");
    url.searchParams.set("code_challenge_method", "plain");
    const res = await makeApp().fetch(new Request(url.toString()), testEnv);
    expect(res.status).toBe(400);
  });

  it("rejects off-allowlist redirect_uri", async () => {
    const url = new URL("https://x.test/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "c");
    url.searchParams.set("redirect_uri", "https://attacker.com/cb");
    url.searchParams.set("code_challenge", "abc");
    url.searchParams.set("code_challenge_method", "S256");
    const res = await makeApp().fetch(new Request(url.toString()), testEnv);
    expect(res.status).toBe(400);
  });

  it("issues a per-client bearer through the full PKCE flow", async () => {
    const { verifier, challenge } = await pkce();
    const approve = await makeApp().fetch(
      new Request("https://x.test/approve", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: "the-approval-code",
          params: JSON.stringify({
            redirect_uri: "https://claude.ai/cb",
            client_id: "client-a",
            code_challenge: challenge,
          }),
        }),
        redirect: "manual",
      }),
      testEnv,
    );
    expect(approve.status).toBe(302);
    const authCode = new URL(approve.headers.get("Location")!).searchParams.get("code")!;

    const tok = await makeApp().fetch(
      new Request("https://x.test/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: verifier,
          redirect_uri: "https://claude.ai/cb",
        }),
      }),
      testEnv,
    );
    expect(tok.status).toBe(200);
    const body = (await tok.json()) as Record<string, unknown>;
    expect(typeof body.access_token).toBe("string");
    expect(body.access_token).not.toBe("the-approval-code");

    const rec = await lookupBearer(testEnv.TEST_KV, body.access_token as string);
    expect(rec?.clientId).toBe("client-a");

    // Bearer middleware accepts it
    const priv = await makeApp().fetch(
      new Request("https://x.test/private", {
        headers: { Authorization: `Bearer ${body.access_token}` },
      }),
      testEnv,
    );
    expect(priv.status).toBe(200);
  });

  it("rejects an incorrect approval code", async () => {
    const { challenge } = await pkce();
    const res = await makeApp().fetch(
      new Request("https://x.test/approve", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: "wrong",
          params: JSON.stringify({
            redirect_uri: "https://claude.ai/cb",
            client_id: "c",
            code_challenge: challenge,
          }),
        }),
      }),
      testEnv,
    );
    expect(res.status).toBe(401);
  });

  it("/register caps redirect_uris count", async () => {
    const res = await makeApp().fetch(
      new Request("https://x.test/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: Array.from({ length: 10 }, (_, i) => `https://claude.ai/cb${i}`),
        }),
      }),
      testEnv,
    );
    expect(res.status).toBe(400);
  });
});
