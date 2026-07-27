const ALLOWED_SCHEMES_DEFAULT: ReadonlySet<string> = new Set(["https:"]);

/**
 * Loopback addresses, per RFC 8252. These are the only places an http: redirect
 * makes sense: a native client (Claude Code, Desktop, an agent CLI) listens on a
 * random localhost port that cannot hold a TLS certificate, and the traffic never
 * leaves the machine.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface RedirectUriOptions {
  allowedHosts: ReadonlySet<string>;
  allowedSchemes?: ReadonlySet<string>;
}

export function isAllowedRedirectUri(uri: string, options: RedirectUriOptions): boolean {
  try {
    const url = new URL(uri);
    const schemes = options.allowedSchemes ?? ALLOWED_SCHEMES_DEFAULT;
    if (!schemes.has(url.protocol)) return false;
    if (!options.allowedHosts.has(url.hostname)) return false;
    // Servers allow http: so their native clients can use a loopback callback.
    // Scheme and host were checked independently before, which let that
    // allowance leak onto remote hosts — sending an authorization code over
    // cleartext to somewhere off the machine. Tie the two together.
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}
