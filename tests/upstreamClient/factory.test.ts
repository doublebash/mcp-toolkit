import { afterEach, describe, expect, it, vi } from "vitest";
import { isToolError } from "../../src/errors/ToolError.js";
import { createUpstreamClient } from "../../src/upstreamClient/factory.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

interface StubResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of responding — simulates a dropped connection or timeout. */
  throws?: Error;
}

/** Replaces global fetch with a queue of canned responses; returns the call log. */
function stubFetch(responses: StubResponse[]): { calls: RequestInit[]; urls: string[] } {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  let i = 0;

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    calls.push(init);
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!spec) throw new Error("stubFetch ran out of responses");
    if (spec.throws) throw spec.throws;
    const headers = new Headers(spec.headers ?? { "Content-Type": "application/json" });
    const body = spec.status === 204 ? null : JSON.stringify(spec.body ?? {});
    return new Response(body, { status: spec.status, headers });
  }) as unknown as typeof fetch;

  return { calls, urls };
}

function client(overrides: Partial<Parameters<typeof createUpstreamClient>[0]> = {}) {
  return createUpstreamClient({
    upstreamName: "TestAPI",
    baseUrl: "https://api.example.com",
    buildHeaders: async () => ({ Authorization: "Bearer t" }),
    // Never actually wait during tests.
    sleep: async () => {},
    ...overrides,
  });
}

describe("happy path", () => {
  it("returns parsed JSON and sends the built headers", async () => {
    const { calls, urls } = stubFetch([{ status: 200, body: { ok: true } }]);
    const result = await client().fetch<{ ok: boolean }>({ method: "GET", path: "/things" });

    expect(result).toEqual({ ok: true });
    expect(urls[0]).toBe("https://api.example.com/things");
    expect((calls[0]?.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("returns undefined for 204 and for non-JSON bodies", async () => {
    stubFetch([{ status: 204 }]);
    expect(await client().fetch({ method: "DELETE", path: "/things/1" })).toBeUndefined();

    stubFetch([{ status: 200, headers: { "Content-Type": "text/html" } }]);
    expect(await client().fetch({ method: "GET", path: "/page" })).toBeUndefined();
  });

  it("drops undefined and empty query values", async () => {
    const { urls } = stubFetch([{ status: 200, body: {} }]);
    await client().fetch({
      method: "GET",
      path: "/search",
      query: { q: "hi", page: 2, skip: undefined, blank: "" },
    });
    expect(urls[0]).toBe("https://api.example.com/search?q=hi&page=2");
  });
});

describe("timeout", () => {
  it("attaches an abort signal to every request", async () => {
    const { calls } = stubFetch([{ status: 200, body: {} }]);
    await client({ timeoutMs: 1234 }).fetch({ method: "GET", path: "/x" });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces a timeout as a 504 ToolError without leaking internals", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    stubFetch([{ status: 0, throws: timeout }]);

    await expect(
      client({ maxAttempts: 1 }).fetch({ method: "GET", path: "/slow" }),
    ).rejects.toMatchObject({
      userMessage: "TestAPI timed out",
      status: 504,
    });
  });
});

describe("retry policy", () => {
  it("retries a 429 and returns the eventual success", async () => {
    const { calls } = stubFetch([
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 200, body: { recovered: true } },
    ]);

    const result = await client().fetch({ method: "GET", path: "/things" });
    expect(result).toEqual({ recovered: true });
    expect(calls.length).toBe(2);
  });

  it("retries a POST on 429 — the upstream says it did not process the request", async () => {
    const { calls } = stubFetch([{ status: 429 }, { status: 200, body: { id: "new" } }]);
    const result = await client().fetch({ method: "POST", path: "/contacts", body: { a: 1 } });

    expect(result).toEqual({ id: "new" });
    expect(calls.length).toBe(2);
    // The body must survive replay intact.
    expect(calls[1]?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("does NOT retry a POST on 5xx — the write may already have landed", async () => {
    const { calls } = stubFetch([{ status: 502 }, { status: 200, body: {} }]);

    await expect(
      client().fetch({ method: "POST", path: "/contacts", body: { a: 1 } }),
    ).rejects.toMatchObject({ status: 502 });
    expect(calls.length).toBe(1);
  });

  it("does retry a GET on 5xx", async () => {
    const { calls } = stubFetch([{ status: 503 }, { status: 200, body: { ok: 1 } }]);
    await client().fetch({ method: "GET", path: "/things" });
    expect(calls.length).toBe(2);
  });

  it("retries an idempotent DELETE after a dropped connection", async () => {
    const { calls } = stubFetch([
      { status: 0, throws: new TypeError("network error") },
      { status: 204 },
    ]);
    await client().fetch({ method: "DELETE", path: "/things/1" });
    expect(calls.length).toBe(2);
  });

  it("does not retry client errors like 404", async () => {
    const { calls } = stubFetch([{ status: 404 }, { status: 200, body: {} }]);

    await expect(client().fetch({ method: "GET", path: "/gone" })).rejects.toMatchObject({
      status: 404,
      userMessage: "TestAPI error 404: not found",
    });
    expect(calls.length).toBe(1);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const { calls } = stubFetch([{ status: 429 }]);

    await expect(
      client({ maxAttempts: 3 }).fetch({ method: "GET", path: "/busy" }),
    ).rejects.toMatchObject({ status: 429, userMessage: "TestAPI error 429: rate limited" });
    expect(calls.length).toBe(3);
  });

  it("maxAttempts: 1 disables retrying entirely", async () => {
    const { calls } = stubFetch([{ status: 429 }, { status: 200, body: {} }]);
    await expect(
      client({ maxAttempts: 1 }).fetch({ method: "GET", path: "/busy" }),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls.length).toBe(1);
  });
});

describe("backoff timing", () => {
  it("waits the Retry-After the server asked for, clamped to 8s", async () => {
    const slept: number[] = [];
    stubFetch([
      { status: 429, headers: { "Retry-After": "2" } },
      { status: 429, headers: { "Retry-After": "9999" } },
      { status: 200, body: {} },
    ]);

    await client({
      maxAttempts: 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).fetch({ method: "GET", path: "/busy" });

    expect(slept).toEqual([2000, 8000]);
  });

  it("falls back to jittered exponential backoff when Retry-After is absent", async () => {
    const slept: number[] = [];
    stubFetch([{ status: 503 }, { status: 503 }, { status: 200, body: {} }]);

    await client({
      maxAttempts: 3,
      backoffBaseMs: 1000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).fetch({ method: "GET", path: "/flaky" });

    expect(slept.length).toBe(2);
    // Full jitter: attempt 1 in [0,1000], attempt 2 in [0,2000].
    expect(slept[0]).toBeGreaterThanOrEqual(0);
    expect(slept[0]).toBeLessThanOrEqual(1000);
    expect(slept[1]).toBeLessThanOrEqual(2000);
  });

  it("ignores an unparseable Retry-After rather than failing", async () => {
    const slept: number[] = [];
    stubFetch([{ status: 429, headers: { "Retry-After": "soon-ish" } }, { status: 200, body: {} }]);

    await client({
      backoffBaseMs: 100,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).fetch({ method: "GET", path: "/busy" });

    expect(slept.length).toBe(1);
    expect(slept[0]).toBeLessThanOrEqual(100);
  });
});

describe("error redaction", () => {
  it("keeps the upstream body out of the user-facing message", async () => {
    stubFetch([
      {
        status: 403,
        body: { message: "token sk-live-abc123 lacks scope contacts.write" },
      },
    ]);

    try {
      await client({ maxAttempts: 1 }).fetch({ method: "GET", path: "/secret" });
      expect.unreachable("should have thrown");
    } catch (e) {
      if (!isToolError(e)) throw e;
      expect(e.userMessage).toBe("TestAPI error 403: forbidden");
      expect(e.userMessage).not.toContain("sk-live-abc123");
      // The detail is still available internally for the structured log.
      expect(e.internalMessage).toContain("sk-live-abc123");
    }
  });

  it("truncates the retained body at maxInternalBodyChars", async () => {
    stubFetch([{ status: 500, body: { pad: "x".repeat(5000) } }]);

    try {
      await client({ maxAttempts: 1, maxInternalBodyChars: 64 }).fetch({
        method: "POST",
        path: "/boom",
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      if (!isToolError(e)) throw e;
      expect(e.internalMessage.length).toBeLessThan(200);
    }
  });
});
