import { describe, expect, it } from "vitest";
import { decryptAtRest, encryptAtRest } from "../../src/crypto/encryption.js";

describe("encryptAtRest / decryptAtRest", () => {
  it("roundtrips plaintext", async () => {
    const ct = await encryptAtRest("hello world", "secret-key-32bytes-or-more", "test-ns");
    const pt = await decryptAtRest(ct, "secret-key-32bytes-or-more", "test-ns");
    expect(pt).toBe("hello world");
  });

  it("emits different ciphertexts each call (random IV)", async () => {
    const a = await encryptAtRest("same", "k", "ns");
    const b = await encryptAtRest("same", "k", "ns");
    expect(a).not.toBe(b);
  });

  it("fails decrypt with the wrong secret", async () => {
    const ct = await encryptAtRest("hello", "secret-a", "ns");
    await expect(decryptAtRest(ct, "secret-b", "ns")).rejects.toThrow();
  });

  it("fails decrypt with the wrong namespace", async () => {
    const ct = await encryptAtRest("hello", "secret-a", "ns1");
    await expect(decryptAtRest(ct, "secret-a", "ns2")).rejects.toThrow();
  });

  it("rejects empty secret or namespace", async () => {
    await expect(encryptAtRest("hi", "", "ns")).rejects.toThrow();
    await expect(encryptAtRest("hi", "k", "")).rejects.toThrow();
  });
});
