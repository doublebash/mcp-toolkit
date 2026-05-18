// Minimal worker entry referenced by wrangler.toml so vitest-pool-workers can boot miniflare.
// The toolkit isn't a deployable worker — this file exists solely to satisfy the test harness.
export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
};
