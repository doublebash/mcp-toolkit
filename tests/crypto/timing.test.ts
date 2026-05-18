import { describe, expect, it } from "vitest";
import { timingSafeEqual } from "../../src/crypto/timing.js";

describe("timingSafeEqual", () => {
  it("returns true for equal strings", async () => {
    expect(await timingSafeEqual("abc", "abc")).toBe(true);
    expect(await timingSafeEqual("", "")).toBe(true);
  });
  it("returns false for different strings", async () => {
    expect(await timingSafeEqual("abc", "abd")).toBe(false);
    expect(await timingSafeEqual("abc", "")).toBe(false);
  });
  it("returns false for differing lengths", async () => {
    expect(await timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
