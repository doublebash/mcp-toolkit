const ALLOWED_SCHEMES_DEFAULT: ReadonlySet<string> = new Set(["https:"]);

export interface RedirectUriOptions {
  allowedHosts: ReadonlySet<string>;
  allowedSchemes?: ReadonlySet<string>;
}

export function isAllowedRedirectUri(uri: string, options: RedirectUriOptions): boolean {
  try {
    const url = new URL(uri);
    const schemes = options.allowedSchemes ?? ALLOWED_SCHEMES_DEFAULT;
    if (!schemes.has(url.protocol)) return false;
    return options.allowedHosts.has(url.hostname);
  } catch {
    return false;
  }
}
