import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export interface CreateVitestConfigOptions {
  /** Path to wrangler.toml relative to the project root. */
  wranglerConfigPath: string;
  /** KV namespaces to bind in miniflare. */
  kvNamespaces?: string[];
  /** Plain-string bindings to expose to tests. */
  bindings?: Record<string, string>;
  /** Compatibility date. Default 2024-11-01. */
  compatibilityDate?: string;
  /** Compatibility flags. Default ['nodejs_compat']. */
  compatibilityFlags?: string[];
}

export function createVitestConfig(options: CreateVitestConfigOptions) {
  return defineWorkersConfig({
    test: {
      poolOptions: {
        workers: {
          wrangler: { configPath: options.wranglerConfigPath },
          miniflare: {
            compatibilityDate: options.compatibilityDate ?? "2024-11-01",
            compatibilityFlags: options.compatibilityFlags ?? ["nodejs_compat"],
            ...(options.kvNamespaces ? { kvNamespaces: options.kvNamespaces } : {}),
            ...(options.bindings ? { bindings: options.bindings } : {}),
          },
        },
      },
    },
  });
}
