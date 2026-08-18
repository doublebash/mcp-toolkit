import { describe, expect, it } from "vitest";
import { truncateList } from "../../src/tools/truncate.js";

const HINT = "Filter by rating to see the rest.";

describe("truncateList", () => {
  it("returns everything untouched when under the limit", () => {
    const r = truncateList([1, 2, 3], "reviews", HINT, 10);
    expect(r.items).toEqual([1, 2, 3]);
    expect(r.returned).toBe(3);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("does not truncate when the count exactly equals the limit", () => {
    const r = truncateList([1, 2, 3], "reviews", HINT, 3);
    expect(r.truncated).toBe(false);
    expect(r.returned).toBe(3);
    expect(r.total).toBe(3);
    expect(r.items).toHaveLength(3);
  });

  it("trims to the limit and reports the true total when over", () => {
    const r = truncateList([1, 2, 3, 4, 5], "reviews", HINT, 2);
    expect(r.items).toEqual([1, 2]);
    expect(r.returned).toBe(2);
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it("handles an empty list", () => {
    const r = truncateList([], "reviews", HINT, 10);
    expect(r.items).toEqual([]);
    expect(r.returned).toBe(0);
    expect(r.total).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.note).toBeUndefined();
  });

  it("treats limit 0 as 'return nothing, and say so'", () => {
    const r = truncateList([1, 2, 3], "reviews", HINT, 0);
    expect(r.items).toEqual([]);
    expect(r.returned).toBe(0);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(true);
    expect(r.note).toContain("first 0 of 3");
  });

  it("omits the note entirely when nothing was trimmed", () => {
    const r = truncateList([1], "reviews", HINT, 5);
    expect(r.note).toBeUndefined();
    expect("note" in r).toBe(false);
  });

  it("writes a note that names the counts, warns against totalling, and carries the hint", () => {
    const r = truncateList([1, 2, 3, 4], "reviews", HINT, 2);
    expect(r.note).toContain("first 2 of 4 reviews");
    expect(r.note).toContain("do not describe it as complete");
    expect(r.note).toContain(HINT);
  });

  it("rejects a negative or fractional limit instead of coercing it", () => {
    expect(() => truncateList([1, 2], "reviews", HINT, -1)).toThrow(RangeError);
    expect(() => truncateList([1, 2], "reviews", HINT, 1.5)).toThrow(RangeError);
    expect(() => truncateList([1, 2], "reviews", HINT, Number.NaN)).toThrow(RangeError);
  });

  it("does not alias the caller's array", () => {
    const source = [1, 2, 3];
    const r = truncateList(source, "reviews", HINT, 10);
    r.items.push(4);
    expect(source).toEqual([1, 2, 3]);
  });
});
