import { describe, expect, it } from "vitest";
import { maskedLink, phoneLine, phoneWanted } from "./phoneSettings";
import type { RemoteStatus } from "./types";

const base: RemoteStatus = { on: true, address: "100.1.2.3", port: 8642, keep_awake: false, has_token: true, token: null, setup_url: null, qr_svg: null };

describe("item 588: Settings → Phone says what the switch does", () => {
  it("off says the phone cannot reach it", () => {
    expect(phoneLine({ ...base, on: false, wanted: false })).toMatch(/^Off/);
    expect(phoneWanted({ ...base, on: false, wanted: false })).toBe(false);
  });
  it("on and waiting for Tailscale is still on", () => {
    const st = { ...base, on: false, wanted: true, phone_kind: "both" as const };
    expect(phoneWanted(st)).toBe(true);
    expect(phoneLine(st)).toMatch(/^On, waiting for Tailscale/);
  });
  it("both hosts names the lid closed", () => {
    expect(phoneLine({ ...base, wanted: true, phone_kind: "both" })).toMatch(/away server when the lid is closed/);
  });
  it("an older backend without wanted reads the listener", () => {
    expect(phoneWanted(base)).toBe(true);
  });
  it("the printed link never carries a token", () => {
    expect(maskedLink("https://a.fly.dev/#token=abc&mac=x&mt=def")).toBe("https://a.fly.dev/#…");
  });
});
