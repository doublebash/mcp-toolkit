import { describe, expect, it } from "vitest";
import { isAllowedRedirectUri } from "../../src/oauth/redirect.js";

const opts = {
  allowedHosts: new Set(["claude.ai", "api.claude.ai"]),
};

describe("isAllowedRedirectUri", () => {
  it("accepts canonical hosts over HTTPS", () => {
    expect(isAllowedRedirectUri("https://claude.ai/cb", opts)).toBe(true);
    expect(isAllowedRedirectUri("https://api.claude.ai/cb", opts)).toBe(true);
  });
  it("rejects http://", () => {
    expect(isAllowedRedirectUri("http://claude.ai/cb", opts)).toBe(false);
  });
  it("rejects javascript:/data:", () => {
    expect(isAllowedRedirectUri("javascript:alert(1)", opts)).toBe(false);
    expect(isAllowedRedirectUri("data:text/html,<script>", opts)).toBe(false);
  });
  it("rejects unknown hosts even over https", () => {
    expect(isAllowedRedirectUri("https://attacker.com/cb", opts)).toBe(false);
    expect(isAllowedRedirectUri("https://preview.claude.ai/cb", opts)).toBe(false);
  });
  it("rejects malformed URIs", () => {
    expect(isAllowedRedirectUri("not a url", opts)).toBe(false);
    expect(isAllowedRedirectUri("", opts)).toBe(false);
  });
});

// Servers opt into http: so native clients can use an RFC 8252 loopback
// callback. That allowance must not extend to remote hosts, or an authorization
// code would travel in cleartext off the machine.
describe("isAllowedRedirectUri with http: enabled for native clients", () => {
  const nativeOpts = {
    allowedHosts: new Set(["claude.ai", "localhost", "127.0.0.1"]),
    allowedSchemes: new Set(["https:", "http:"]),
  };

  it("accepts http:// on loopback", () => {
    expect(isAllowedRedirectUri("http://localhost:8976/cb", nativeOpts)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:8976/cb", nativeOpts)).toBe(true);
  });

  it("still rejects http:// on a remote host, even an allowed one", () => {
    expect(isAllowedRedirectUri("http://claude.ai/cb", nativeOpts)).toBe(false);
  });

  it("keeps accepting https:// everywhere allowed", () => {
    expect(isAllowedRedirectUri("https://claude.ai/cb", nativeOpts)).toBe(true);
    expect(isAllowedRedirectUri("https://localhost:8976/cb", nativeOpts)).toBe(true);
  });

  it("does not let an unlisted loopback-looking host through", () => {
    expect(isAllowedRedirectUri("http://localhost.attacker.com/cb", nativeOpts)).toBe(false);
  });
});
