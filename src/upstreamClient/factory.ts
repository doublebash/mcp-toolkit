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
  504: "upstream timeout",
};

/** Methods HTTP defines as idempotent — safe to replay after a failure of unknown outcome. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "PUT", "DELETE", "HEAD"]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
/** Ceiling on any single backoff sleep, so a hostile Retry-After can't stall the Worker. */
const MAX_BACKOFF_MS = 8_000;

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
  /** Per-attempt request timeout. Default 30s. */
  timeoutMs?: number;
  /** Total attempts including the first. Default 3 (i.e. up to 2 retries). Set 1 to disable. */
  maxAttempts?: number;
  /** First backoff delay; doubles each retry, plus jitter. Default 500ms. */
  backoffBaseMs?: number;
  /** Injectable sleep — tests pass a no-op so they don't wait out real backoff. */
  sleep?: (ms: number) => Promise<void>;
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failed attempt is worth replaying.
 *
 * 429 is always retryable: the upstream is telling us it did NOT process the
 * request, so even a POST can safely go again. Anything else of unknown outcome
 * (5xx, a dropped connection, our own timeout) is only replayed for idempotent
 * methods — retrying a POST there risks creating the contact/deal/task twice.
 */
function isRetryable(method: string, status: number | undefined): boolean {
  if (status === 429) return true;
  if (!IDEMPOTENT_METHODS.has(method)) return false;
  if (status === undefined) return true; // network error or timeout
  return status >= 500;
}

/** Honour Retry-After (delta-seconds or HTTP-date), clamped so it can't stall us. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }

  const at = Date.parse(header);
  if (Number.isFinite(at)) {
    return Math.min(Math.max(at - Date.now(), 0), MAX_BACKOFF_MS);
  }
  return undefined;
}

export function createUpstreamClient(options: UpstreamClientOptions): UpstreamClient {
  const statusSummaries = { ...DEFAULT_STATUS_SUMMARIES, ...(options.statusSummaries ?? {}) };
  const maxBody = options.maxInternalBodyChars ?? 1024;
  const defaultHeaders = options.defaultHeaders ?? {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const sleep = options.sleep ?? defaultSleep;

  function summaryFor(status: number): string {
    return statusSummaries[status] ?? "upstream error";
  }

  function backoffFor(attempt: number): number {
    const exponential = Math.min(backoffBaseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    // Full jitter — spreads out concurrent retries instead of re-colliding.
    return Math.round(Math.random() * exponential);
  }

  async function call<T>(init: UpstreamRequestInit): Promise<T> {
    const url = buildUrl(options.baseUrl, init.path, init.query);
    const serialisedBody =
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body);

    let lastError: ToolError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const headers = {
        ...defaultHeaders,
        ...(await options.buildHeaders()),
        ...(init.headers ?? {}),
      };
      const requestInit: RequestInit = {
        method: init.method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (serialisedBody !== undefined) requestInit.body = serialisedBody;

      let response: Response;
      try {
        response = await fetch(url, requestInit);
      } catch (cause) {
        // Timeout or transport failure — no status, so the outcome is unknown.
        const timedOut = cause instanceof Error && cause.name === "TimeoutError";
        lastError = new ToolError({
          userMessage: timedOut
            ? `${options.upstreamName} timed out`
            : `${options.upstreamName} unreachable`,
          internalMessage: `${options.upstreamName} ${init.method} ${init.path} attempt ${attempt}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          status: 504,
          upstreamName: options.upstreamName,
        });
        log.warn("upstream_transport_error", {
          upstream: options.upstreamName,
          method: init.method,
          path: init.path,
          attempt,
          timedOut,
        });
        if (attempt < maxAttempts && isRetryable(init.method, undefined)) {
          await sleep(backoffFor(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const ct = response.headers.get("Content-Type") ?? "";
        if (!ct.includes("application/json")) return undefined as T;
        return (await response.json()) as T;
      }

      const detail = await response.text().catch(() => "");
      const retryable = isRetryable(init.method, response.status);
      const willRetry = retryable && attempt < maxAttempts;

      log[willRetry ? "warn" : "error"](willRetry ? "upstream_retrying" : "upstream_error", {
        upstream: options.upstreamName,
        status: response.status,
        method: init.method,
        path: init.path,
        attempt,
      });

      lastError = ToolError.upstream(
        options.upstreamName,
        response.status,
        summaryFor(response.status),
        detail.slice(0, maxBody),
      );

      if (!willRetry) throw lastError;
      await sleep(retryAfterMs(response) ?? backoffFor(attempt));
    }

    // Unreachable: the loop either returns or throws. Kept so the type checker
    // sees a definite result and any future edit to the loop fails loudly.
    throw (
      lastError ??
      new ToolError({
        userMessage: `${options.upstreamName} request failed`,
        internalMessage: `${options.upstreamName} exhausted ${maxAttempts} attempts with no recorded error`,
      })
    );
  }

  return { fetch: call };
}
