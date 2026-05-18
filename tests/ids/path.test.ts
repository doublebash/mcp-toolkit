import { describe, expect, it } from "vitest";
import { ToolError } from "../../src/errors/ToolError.js";
import { buildPath, ghlIdValidator, uuidValidator } from "../../src/ids/path.js";

describe("buildPath with ghlIdValidator", () => {
  it("encodes valid segments", () => {
    expect(buildPath("/contacts/{contactId}", { contactId: "abc123" }, { idValidator: ghlIdValidator }))
      .toBe("/contacts/abc123");
  });
  it("rejects traversal", () => {
    expect(() =>
      buildPath("/contacts/{contactId}", { contactId: "../wf" }, { idValidator: ghlIdValidator }),
    ).toThrow(ToolError);
  });
  it("throws when path parameter is missing", () => {
    expect(() => buildPath("/c/{contactId}", {}, { idValidator: ghlIdValidator })).toThrow(ToolError);
  });
});

describe("buildPath with uuidValidator", () => {
  const ok = "01fe24f3-aaaa-bbbb-cccc-0123456789ab";
  it("accepts a real UUID", () => {
    expect(buildPath("/x/{id}", { id: ok }, { idValidator: uuidValidator })).toBe(`/x/${ok}`);
  });
  it("rejects a non-UUID", () => {
    expect(() => buildPath("/x/{id}", { id: "abc" }, { idValidator: uuidValidator })).toThrow(ToolError);
  });
});
