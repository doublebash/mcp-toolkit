import { z } from "zod";
import { randomBase64UrlToken, sha256Base64Url } from "../crypto/encoding.js";

const BEARER_KEY_PREFIX = "bearer:";

export const bearerRecordSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().url().optional(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

export type BearerRecord = z.infer<typeof bearerRecordSchema>;

export interface IssuedBearer {
  rawToken: string;
  expiresAt: number;
}

export interface IssueBearerInput {
  clientId: string;
  redirectUri?: string;
  ttlSeconds: number;
  now?: number;
}

export async function issueBearer(
  kv: KVNamespace,
  input: IssueBearerInput,
): Promise<IssuedBearer> {
  const now = input.now ?? Date.now();
  const expiresAt = now + input.ttlSeconds * 1000;

  const rawToken = randomBase64UrlToken(32);
  const hash = await sha256Base64Url(rawToken);

  const record: BearerRecord = {
    clientId: input.clientId,
    ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
    issuedAt: now,
    expiresAt,
  };

  await kv.put(`${BEARER_KEY_PREFIX}${hash}`, JSON.stringify(record), {
    expirationTtl: input.ttlSeconds,
  });

  return { rawToken, expiresAt };
}

export async function lookupBearer(
  kv: KVNamespace,
  rawToken: string,
  now: number = Date.now(),
): Promise<BearerRecord | null> {
  if (!rawToken) return null;
  const hash = await sha256Base64Url(rawToken);
  const stored = await kv.get(`${BEARER_KEY_PREFIX}${hash}`);
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  const result = bearerRecordSchema.safeParse(parsed);
  if (!result.success) return null;
  if (result.data.expiresAt <= now) return null;
  return result.data;
}

export async function revokeBearer(kv: KVNamespace, rawToken: string): Promise<void> {
  if (!rawToken) return;
  const hash = await sha256Base64Url(rawToken);
  await kv.delete(`${BEARER_KEY_PREFIX}${hash}`);
}
