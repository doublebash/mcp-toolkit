import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { ToolError } from "../errors/ToolError.js";
import { log } from "../log/log.js";

const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const toolsCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const initializeParamsSchema = z
  .object({
    protocolVersion: z.string().optional(),
  })
  .partial();

export interface McpRouterOptions<Env extends object> {
  serverName: string;
  serverVersion: string;
  protocolVersions: readonly string[];
  defaultProtocolVersion: string;
  toolDefinitions: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
  dispatch: (
    env: Env,
    ctx: Context<{ Bindings: Env }>,
    name: string,
    args: unknown,
  ) => Promise<unknown>;
  rateLimiter?: MiddlewareHandler<{ Bindings: Env }> | undefined;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

function negotiateProtocol(
  clientVersion: string | undefined,
  supported: readonly string[],
  fallback: string,
): string {
  if (!clientVersion) return fallback;
  for (const v of supported) {
    if (v === clientVersion) return v;
  }
  return fallback;
}

export function createMcpRouter<Env extends object>(
  options: McpRouterOptions<Env>,
): Hono<{ Bindings: Env }> {
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const app = new Hono<{ Bindings: Env }>();

  const rateLimiter = options.rateLimiter;

  const handler = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    const lenHeader = c.req.header("Content-Length");
    if (lenHeader && Number(lenHeader) > maxBytes) {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Payload too large" } },
        413,
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }

    const parsed = jsonRpcRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
        400,
      );
    }

    const { id, method, params } = parsed.data;
    const respondId = id ?? null;
    const ok = (result: unknown) =>
      c.json({ jsonrpc: "2.0", id: respondId, result });

    switch (method) {
      case "initialize": {
        const ip = initializeParamsSchema.safeParse(params);
        const clientVersion = ip.success ? ip.data.protocolVersion : undefined;
        const negotiated = negotiateProtocol(
          clientVersion,
          options.protocolVersions,
          options.defaultProtocolVersion,
        );
        const responseBody = JSON.stringify({
          jsonrpc: "2.0",
          id: respondId,
          result: {
            protocolVersion: negotiated,
            capabilities: { tools: {} },
            serverInfo: { name: options.serverName, version: options.serverVersion },
          },
        });
        return new Response(responseBody, {
          headers: {
            "Content-Type": "application/json",
            "Mcp-Session-Id": crypto.randomUUID(),
          },
        });
      }

      case "notifications/initialized":
      case "ping":
        return ok({});

      case "tools/list":
        return ok({ tools: options.toolDefinitions });

      case "tools/call": {
        const cp = toolsCallParamsSchema.safeParse(params);
        if (!cp.success) {
          return c.json(
            {
              jsonrpc: "2.0",
              id: respondId,
              error: { code: -32602, message: "Invalid params" },
            },
            400,
          );
        }
        const startedAt = Date.now();
        try {
          const result = await options.dispatch(c.env, c, cp.data.name, cp.data.arguments ?? {});
          log.info("tool_call", {
            tool: cp.data.name,
            ok: true,
            duration_ms: Date.now() - startedAt,
          });
          return ok({
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (e) {
          const isTool = e instanceof ToolError;
          const userMessage = isTool ? e.userMessage : "tool execution failed";
          const internalMessage = isTool
            ? e.internalMessage
            : e instanceof Error
              ? e.message
              : String(e);
          log.error("tool_call", {
            tool: cp.data.name,
            ok: false,
            duration_ms: Date.now() - startedAt,
            status: isTool ? (e.status ?? null) : null,
            internal: internalMessage.slice(0, 512),
          });
          return ok({
            content: [{ type: "text", text: `Error: ${userMessage}` }],
            isError: true,
          });
        }
      }

      default:
        return c.json(
          {
            jsonrpc: "2.0",
            id: respondId,
            error: { code: -32601, message: `Method not found: ${method}` },
          },
          404,
        );
    }
  };

  if (rateLimiter) {
    app.post("/mcp", rateLimiter, handler);
  } else {
    app.post("/mcp", handler);
  }

  return app;
}
