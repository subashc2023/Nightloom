import { describe, expect, it } from "vitest";
import { cardKind } from "../remote/client";
import { DECLINE_TIP, SECRET_TOOL, USE_TIP, isSecretRequest, secretView } from "./secret";

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
