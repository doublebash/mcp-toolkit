import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { sha256Base64Url } from "../crypto/encoding.js";
import { timingSafeEqual } from "../crypto/timing.js";
import { log } from "../log/log.js";
import { approvePage, deniedPage } from "../http/pages.js";
import { escapeHtml } from "../http/escape.js";
import { isAllowedRedirectUri } from "./redirect.js";
import { issueBearer } from "./tokens.js";

const AUTH_CODE_KEY_PREFIX = "code:";
const DEFAULT_AUTH_CODE_TTL_SECONDS = 5 * 60;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_OAUTH_STATE_MAX_LENGTH = 512;
const DEFAULT_REGISTER_BODY_MAX_BYTES = 4 * 1024;
const DEFAULT_REGISTER_MAX_REDIRECT_URIS = 5;

const authCodePayloadSchema = z.object({
  codeChallenge: z.string().min(1),
  redirectUri: z.string().url(),
  clientId: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});

type AuthCodePayload = z.infer<typeof authCodePayloadSchema>;

export interface OAuthServerOptions<Env extends object> {
  serverName: string;
  serverDescription?: string;
  logo?: string;
  approvalCodeName: string;
  kv: (env: Env) => KVNamespace;
  approvalCodeSecret: (env: Env) => string;
  allowedRedirectHosts: ReadonlySet<string>;
  allowedRedirectSchemes?: ReadonlySet<string>;
  rateLimiters?: {
    approve?: MiddlewareHandler<{ Bindings: Env }>;
    token?: MiddlewareHandler<{ Bindings: Env }>;
    register?: MiddlewareHandler<{ Bindings: Env }>;
  };
  accessTokenTtlSeconds?: number;
  authCodeTtlSeconds?: number;
  oauthStateMaxLength?: number;
  registerBodyMaxBytes?: number;
  registerMaxRedirectUris?: number;
}

export interface OAuthServerHandle<Env extends object> {
  routes: Hono<{ Bindings: Env }>;
}

export function createOAuthServer<Env extends object>(
  options: OAuthServerOptions<Env>,
): OAuthServerHandle<Env> {
  const accessTokenTtl = options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const authCodeTtl = options.authCodeTtlSeconds ?? DEFAULT_AUTH_CODE_TTL_SECONDS;
  const stateMax = options.oauthStateMaxLength ?? DEFAULT_OAUTH_STATE_MAX_LENGTH;
  const registerBodyMax = options.registerBodyMaxBytes ?? DEFAULT_REGISTER_BODY_MAX_BYTES;
  const registerMaxUris = options.registerMaxRedirectUris ?? DEFAULT_REGISTER_MAX_REDIRECT_URIS;

  const redirectOpts = {
    allowedHosts: options.allowedRedirectHosts,
    ...(options.allowedRedirectSchemes !== undefined
      ? { allowedSchemes: options.allowedRedirectSchemes }
      : {}),
  };

  const authorizeQuerySchema = z.object({
    response_type: z.literal("code"),
    client_id: z.string().min(1).max(256),
    redirect_uri: z.string().url(),
    state: z.string().max(stateMax).optional(),
    code_challenge: z.string().min(1).max(128),
    code_challenge_method: z.literal("S256"),
  });

  const approveParamsSchema = z.object({
    redirect_uri: z.string().url(),
    client_id: z.string().min(1).max(256),
    state: z.string().max(stateMax).optional(),
    code_challenge: z.string().min(1).max(128),
  });

  const tokenBodySchema = z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1).max(256),
    code_verifier: z.string().min(43).max(128),
    redirect_uri: z.string().url(),
    client_id: z.string().min(1).max(256).optional(),
  });

  const registerBodySchema = z
    .object({
      client_name: z.string().min(1).max(256).optional(),
      redirect_uris: z
        .array(z.string().url().max(2048))
        .max(registerMaxUris)
        .optional(),
    })
    .passthrough();

  const app = new Hono<{ Bindings: Env }>();

  type Ctx = Context<{ Bindings: Env }>;

  // ── Well-known metadata ──────────────────────────────────────────────────
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const base = new URL(c.req.url).origin;
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const base = new URL(c.req.url).origin;
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // ── /authorize ────────────────────────────────────────────────────────────
  app.get("/authorize", (c) => {
    const parsed = authorizeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.text("invalid_request: malformed query parameters", 400);
    }
    const { redirect_uri, state, code_challenge, client_id } = parsed.data;
    if (!isAllowedRedirectUri(redirect_uri, redirectOpts)) {
      return c.text("invalid_request: redirect_uri not permitted", 400);
    }
    const safeParams = escapeHtml(
      JSON.stringify({ redirect_uri, state, code_challenge, client_id }),
    );
    return c.html(
      approvePage({
        serverName: options.serverName,
        ...(options.serverDescription !== undefined
          ? { serverDescription: options.serverDescription }
          : {}),
        approvalCodeName: options.approvalCodeName,
        safeParams,
        ...(options.logo !== undefined ? { logo: options.logo } : {}),
      }),
    );
  });

  // ── /approve ──────────────────────────────────────────────────────────────
  const approveHandler = async (c: Ctx): Promise<Response> => {
    const form = await c.req.formData();
    const code = form.get("code");
    const paramsRaw = form.get("params");
    if (typeof code !== "string" || typeof paramsRaw !== "string") {
      return c.text("Bad request", 400);
    }
    if (code.length > 512) return c.text("Bad request", 400);

    const expected = options.approvalCodeSecret(c.env) ?? "";
    const ok = await timingSafeEqual(code, expected);
    if (!expected || !ok) {
      log.warn("approve_denied", { server: options.serverName });
      return c.html(deniedPage(options.serverName), 401);
    }

    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(paramsRaw);
    } catch {
      return c.text("Bad request: invalid params", 400);
    }
    const parsed = approveParamsSchema.safeParse(parsedRaw);
    if (!parsed.success) return c.text("Bad request: invalid params", 400);

    const { redirect_uri, state, code_challenge, client_id } = parsed.data;
    if (!isAllowedRedirectUri(redirect_uri, redirectOpts)) {
      return c.text("Bad request: redirect_uri not permitted", 400);
    }

    const authCode = crypto.randomUUID();
    const payload: AuthCodePayload = {
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      clientId: client_id,
      expiresAt: Date.now() + authCodeTtl * 1000,
    };
    await options
      .kv(c.env)
      .put(`${AUTH_CODE_KEY_PREFIX}${authCode}`, JSON.stringify(payload), {
        expirationTtl: authCodeTtl,
      });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", authCode);
    if (state) redirectUrl.searchParams.set("state", state);

    log.info("approve_granted", { server: options.serverName, clientId: client_id });
    return c.redirect(redirectUrl.toString());
  };

  if (options.rateLimiters?.approve) {
    app.post("/approve", options.rateLimiters.approve, approveHandler);
  } else {
    app.post("/approve", approveHandler);
  }

  // ── /token ────────────────────────────────────────────────────────────────
  const tokenHandler = async (c: Ctx): Promise<Response> => {
    const contentType = c.req.header("Content-Type") ?? "";
    let body: Record<string, unknown>;
    try {
      if (contentType.includes("application/json")) {
        body = (await c.req.json()) as Record<string, unknown>;
      } else {
        const form = await c.req.formData();
        const entries: [string, unknown][] = [];
        form.forEach((v, k) => entries.push([k, v]));
        body = Object.fromEntries(entries);
      }
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }

    const parsed = tokenBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { code, code_verifier, redirect_uri, client_id } = parsed.data;

    const kv = options.kv(c.env);
    const stored = await kv.get(`${AUTH_CODE_KEY_PREFIX}${code}`);
    if (!stored) return c.json({ error: "invalid_grant" }, 400);

    let payloadRaw: unknown;
    try {
      payloadRaw = JSON.parse(stored);
    } catch {
      await kv.delete(`${AUTH_CODE_KEY_PREFIX}${code}`);
      return c.json({ error: "server_error" }, 500);
    }
    const payloadResult = authCodePayloadSchema.safeParse(payloadRaw);
    if (!payloadResult.success) {
      await kv.delete(`${AUTH_CODE_KEY_PREFIX}${code}`);
      return c.json({ error: "server_error" }, 500);
    }
    const payload = payloadResult.data;

    if (Date.now() > payload.expiresAt) {
      await kv.delete(`${AUTH_CODE_KEY_PREFIX}${code}`);
      return c.json({ error: "invalid_grant" }, 400);
    }
    if (redirect_uri !== payload.redirectUri) return c.json({ error: "invalid_grant" }, 400);
    if (client_id && client_id !== payload.clientId) return c.json({ error: "invalid_grant" }, 400);

    const verifierHash = await sha256Base64Url(code_verifier);
    if (!(await timingSafeEqual(verifierHash, payload.codeChallenge))) {
      return c.json({ error: "invalid_grant" }, 400);
    }

    await kv.delete(`${AUTH_CODE_KEY_PREFIX}${code}`);

    const issued = await issueBearer(kv, {
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      ttlSeconds: accessTokenTtl,
    });

    log.info("token_issued", {
      server: options.serverName,
      clientId: payload.clientId,
      expiresAt: issued.expiresAt,
    });

    return c.json({
      access_token: issued.rawToken,
      token_type: "Bearer",
      expires_in: accessTokenTtl,
    });
  };

  if (options.rateLimiters?.token) {
    app.post("/token", options.rateLimiters.token, tokenHandler);
  } else {
    app.post("/token", tokenHandler);
  }

  // ── /register ─────────────────────────────────────────────────────────────
  const registerHandler = async (c: Ctx): Promise<Response> => {
    const lenHeader = c.req.header("Content-Length");
    if (lenHeader && Number(lenHeader) > registerBodyMax) {
      return c.json({ error: "invalid_request" }, 413);
    }
    let raw: unknown = {};
    try {
      const text = await c.req.text();
      if (text.length > registerBodyMax) {
        return c.json({ error: "invalid_request" }, 413);
      }
      if (text.trim().length > 0) raw = JSON.parse(text);
    } catch {
      // empty/invalid body — proceed with empty metadata
    }
    const parsed = registerBodySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid_client_metadata" }, 400);

    return c.json(
      {
        client_id: crypto.randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(parsed.data.redirect_uris ? { redirect_uris: parsed.data.redirect_uris } : {}),
        ...(parsed.data.client_name ? { client_name: parsed.data.client_name } : {}),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        code_challenge_methods: ["S256"],
      },
      201,
    );
  };

  if (options.rateLimiters?.register) {
    app.post("/register", options.rateLimiters.register, registerHandler);
  } else {
    app.post("/register", registerHandler);
  }

  return { routes: app };
}

export const OAUTH_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/authorize",
  "/approve",
  "/token",
  "/register",
]);
