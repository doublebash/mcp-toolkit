import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError } from "../../src/errors/ToolError.js";
import { defineTools } from "../../src/tools/define.js";

const tools = defineTools<{ multiplier: number }>({
  add: {
    schema: z.object({ a: z.number(), b: z.number() }),
    description: "Add two numbers",
    handler: async (env, { a, b }) => (a + b) * env.multiplier,
  },
  echo: {
    schema: z.object({ msg: z.string().min(1).max(64) }),
    description: "Echoes the message",
    handler: async (_env, { msg }) => ({ echoed: msg }),
  },
});

describe("defineTools", () => {
  it("derives JSON Schema with type=object and properties", () => {
    const add = tools.toolDefinitions.find((t) => t.name === "add")!;
    expect(add.description).toMatch(/Add/);
    const s = add.inputSchema as { type?: string; properties?: Record<string, unknown> };
    expect(s.type).toBe("object");
    expect(s.properties).toBeDefined();
    expect(s.properties && "a" in s.properties).toBe(true);
  });

  it("dispatches with parsed args", async () => {
    const result = await tools.dispatch({ multiplier: 2 }, "add", { a: 3, b: 4 });
    expect(result).toBe(14);
  });

  it("throws ToolError.validation on bad args", async () => {
    await expect(tools.dispatch({ multiplier: 1 }, "add", { a: "wrong", b: 4 })).rejects.toThrow(ToolError);
  });

  it("throws ToolError.validation on unknown tool", async () => {
    await expect(tools.dispatch({ multiplier: 1 }, "nope", {})).rejects.toThrow(ToolError);
  });
});
