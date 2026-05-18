import { bytesToBase64Url, base64UrlToBytes } from "./encoding.js";

const HKDF_SALT_PREFIX = "mcp-toolkit-v1:";
const HKDF_INFO = "token-storage";
const IV_BYTES = 12;

async function deriveKey(secret: string, namespace: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(`${HKDF_SALT_PREFIX}${namespace}`),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptAtRest(
  plaintext: string,
  secret: string,
  namespace: string,
): Promise<string> {
  if (!secret) throw new Error("encryptAtRest: secret required");
  if (!namespace) throw new Error("encryptAtRest: namespace required");
  const key = await deriveKey(secret, namespace);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_BYTES);
  return bytesToBase64Url(combined);
}

export async function decryptAtRest(
  ciphertext: string,
  secret: string,
  namespace: string,
): Promise<string> {
  if (!secret) throw new Error("decryptAtRest: secret required");
  if (!namespace) throw new Error("decryptAtRest: namespace required");
  const combined = base64UrlToBytes(ciphertext);
  if (combined.length <= IV_BYTES) throw new Error("decryptAtRest: ciphertext too short");
  const iv = combined.subarray(0, IV_BYTES);
  const data = combined.subarray(IV_BYTES);
  const key = await deriveKey(secret, namespace);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plaintext);
}
