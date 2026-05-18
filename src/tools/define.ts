import { z } from "zod";
import { ToolError } from "../errors/ToolError.js";

export interface ToolDefinitionSpec<Env> {
  schema: z.ZodTypeAny;
  description: string;
  // Args is typed as `any` here so callers can write
  //   handler: (env, { a, b }) => ...
  // with full inference from the schema. The dispatcher runs `schema.parse(args)`
  // before calling, so the value passed in is guaranteed to match `z.infer<schema>`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (env: Env, args: any) => Promise<unknown>;
}

export type ToolMap<Env> = Record<string, ToolDefinitionSpec<Env>>;

export interface PublishedToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface DefinedTools<Env> {
  toolDefinitions: readonly PublishedToolDefinition[];
  dispatch: (env: Env, name: string, args: unknown) => Promise<unknown>;
}

function deriveJsonSchema(schema: z.ZodTypeAny): unknown {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete raw.$schema;
  if (raw.type === undefined) raw.type = "object";
  if (raw.properties === undefined) raw.properties = {};
  return raw;
}

export function defineTools<Env>(tools: ToolMap<Env>): DefinedTools<Env> {
  const definitions: PublishedToolDefinition[] = Object.entries(tools).map(([name, spec]) => ({
    name,
    description: spec.description,
    inputSchema: deriveJsonSchema(spec.schema),
  }));

  async function dispatch(env: Env, name: string, args: unknown): Promise<unknown> {
    const spec = tools[name];
    if (!spec) throw ToolError.validation("unknown tool", `unknown tool: ${name}`);
    const parsed = spec.schema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const detail = issue
        ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
        : "validation failed";
      throw ToolError.validation(
        `invalid arguments — ${detail}`,
        JSON.stringify(parsed.error.issues),
      );
    }
    return spec.handler(env, parsed.data);
  }

  return { toolDefinitions: definitions, dispatch };
}
