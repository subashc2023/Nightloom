import { describe, expect, it } from "vitest";
import { cardKind } from "../remote/client";
import {
  BW_ALWAYS_TIP,
  BW_NO_COMMAND_TIP,
  BW_ONCE_TIP,
  DECLINE_TIP,
  SECRET_TOOL,
  USE_TIP,
  bwNotReady,
  commandPrefix,
  defaultQuery,
  firstField,
  isSecretRequest,
  secretCommand,
  secretView,
} from "./secret";

describe("the secret-request card (item 766)", () => {
  it("is the card for request_secret and nothing else", () => {
    expect(isSecretRequest(SECRET_TOOL)).toBe(true);
    expect(isSecretRequest("mcp__nightloom__add_folder")).toBe(false);
    expect(cardKind({ id: "1", name: SECRET_TOOL, input: {}, effect: "mutating" as never })).toBe("secret");
  });

  it("reads the name raised and the reason, never anything else", () => {
    expect(secretView({ name: " github_token ", why: " to push " })).toEqual({ name: "GITHUB_TOKEN", why: "to push" });
    expect(secretView({})).toEqual({ name: "a secret", why: null });
    expect(secretView(null)).toEqual({ name: "a secret", why: null });
  });

  it("keeps its tips to two short lines", () => {
    for (const t of [USE_TIP, DECLINE_TIP]) {
      const lines = t.split("\n");
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(48);
    }
  });
});

describe("From Bitwarden on the secret card (item 766 part 2)", () => {
  it("reads the command the model named, and its prefix as the backend keeps it", () => {
    expect(secretCommand({ name: "X", command: " gh release create v1 " })).toBe("gh release create v1");
    expect(secretCommand({ name: "X" })).toBeNull();
    // The same cases as bitwarden::command_prefix's test.
    expect(commandPrefix("gh release create v1 --notes x")).toBe("gh release create");
    expect(commandPrefix('curl -H "Authorization: x" https://a')).toBe("curl");
    expect(commandPrefix("npm publish")).toBe("npm publish");
    expect(commandPrefix("./deploy.sh prod")).toBe("./deploy.sh prod");
    expect(commandPrefix("TOKEN=$(cat x) gh api")).toBeNull();
    expect(commandPrefix("$(cat x)")).toBeNull();
    expect(commandPrefix(null)).toBeNull();
  });

  it("says which of the three not-ready states it is, with what he does", () => {
    expect(bwNotReady("missing", "mac")).toContain("brew install bitwarden-cli");
    expect(bwNotReady("unauthenticated", "mac")).toContain("bw login");
    expect(bwNotReady("locked", "mac")).toContain("bw unlock --raw");
    expect(bwNotReady("locked", "phone")).toContain("Mac");
    expect(bwNotReady("unlocked", "mac")).toBeNull();
  });

  it("starts the search from the name and picks the password first", () => {
    expect(defaultQuery("GITHUB_TOKEN")).toBe("github");
    expect(defaultQuery("A_NPM_KEY")).toBe("npm");
    expect(firstField({ id: "1", name: "x", host: null, fields: ["username", "password"] })).toBe("password");
    expect(firstField({ id: "1", name: "x", host: null, fields: ["username", "field:token"] })).toBe("field:token");
    expect(firstField({ id: "1", name: "x", host: null, fields: [] })).toBeNull();
  });

  it("keeps its tips to two short lines", () => {
    for (const t of [BW_ONCE_TIP, BW_ALWAYS_TIP, BW_NO_COMMAND_TIP]) {
      const lines = t.split("\n");
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(48);
    }
  });
});
