import { ToolError } from "../errors/ToolError.js";
import { log } from "../log/log.js";

const DEFAULT_STATUS_SUMMARIES: Record<number, string> = {
  400: "bad request",
  401: "unauthorized",
  403: "forbidden",
  404: "not found",
  409: "conflict",
  422: "unprocessable entity",
  429: "rate limited",
};

export interface UpstreamRequestInit {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface UpstreamClientOptions {
  /** Logical name surfaced in errors + logs (e.g. 'GHL', 'Xero', 'Graph'). */
  upstreamName: string;
  /** Base URL — e.g. 'https://services.leadconnectorhq.com'. */
  baseUrl: string;
  /** Function that produces auth + version headers for each request. */
  buildHeaders: () => Promise<Record<string, string>>;
  /** Default Content-Type + Accept handling. Override if you need XML etc. */
  defaultHeaders?: Record<string, string>;
  /** Mapping of HTTP status -> short safe summary. */
  statusSummaries?: Record<number, string>;
  /** Max characters from the raw upstream error body to retain internally. */
  maxInternalBodyChars?: number;
}

export interface UpstreamClient {
  fetch<T = unknown>(init: UpstreamRequestInit): Promise<T>;
}

function buildUrl(baseUrl: string, path: string, query?: UpstreamRequestInit["query"]): string {
  const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export function createUpstreamClient(options: UpstreamClientOptions): UpstreamClient {
  const statusSummaries = { ...DEFAULT_STATUS_SUMMARIES, ...(options.statusSummaries ?? {}) };
  const maxBody = options.maxInternalBodyChars ?? 1024;
  const defaultHeaders = options.defaultHeaders ?? {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  function summaryFor(status: number): string {
    return statusSummaries[status] ?? "upstream error";
  }

  async function call<T>(init: UpstreamRequestInit): Promise<T> {
    const url = buildUrl(options.baseUrl, init.path, init.query);
    const headers = {
      ...defaultHeaders,
      ...(await options.buildHeaders()),
      ...(init.headers ?? {}),
    };
    const requestInit: RequestInit = { method: init.method, headers };
    if (init.body !== undefined) {
      requestInit.body =
        typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    }

    const response = await fetch(url, requestInit);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      log.error("upstream_error", {
        upstream: options.upstreamName,
        status: response.status,
        method: init.method,
        path: init.path,
      });
      throw ToolError.upstream(
        options.upstreamName,
        response.status,
        summaryFor(response.status),
        detail.slice(0, maxBody),
      );
    }

    if (response.status === 204) return undefined as T;
    const ct = response.headers.get("Content-Type") ?? "";
    if (!ct.includes("application/json")) return undefined as T;
    return (await response.json()) as T;
  }

  return { fetch: call };
}
