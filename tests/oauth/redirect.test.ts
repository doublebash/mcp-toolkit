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
