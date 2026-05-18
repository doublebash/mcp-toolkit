export interface ToolErrorInit {
  userMessage: string;
  internalMessage?: string;
  status?: number;
  upstreamName?: string;
}

export class ToolError extends Error {
  readonly userMessage: string;
  readonly internalMessage: string;
  readonly status: number | undefined;
  readonly upstreamName: string | undefined;

  constructor(init: ToolErrorInit) {
    super(init.internalMessage ?? init.userMessage);
    this.name = "ToolError";
    this.userMessage = init.userMessage;
    this.internalMessage = init.internalMessage ?? init.userMessage;
    this.status = init.status;
    this.upstreamName = init.upstreamName;
  }

  static notFound(kind: string, id: string): ToolError {
    return new ToolError({
      userMessage: `${kind} not found`,
      internalMessage: `${kind} not found: ${id}`,
      status: 404,
    });
  }

  static validation(message: string, internal?: string): ToolError {
    return new ToolError({
      userMessage: message,
      ...(internal !== undefined ? { internalMessage: internal } : {}),
      status: 400,
    });
  }

  static upstream(
    upstreamName: string,
    status: number,
    safeSummary: string,
    internalDetail: string,
  ): ToolError {
    return new ToolError({
      userMessage: `${upstreamName} error ${status}: ${safeSummary}`,
      internalMessage: `${upstreamName} ${status}: ${internalDetail}`,
      status,
      upstreamName,
    });
  }
}

export function isToolError(e: unknown): e is ToolError {
  return e instanceof ToolError;
}
