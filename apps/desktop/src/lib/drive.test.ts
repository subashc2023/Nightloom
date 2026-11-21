import { describe, expect, it } from "vitest";
import { DRIVE_TOOL, driveKey, driveWhy, handBackAnswer, isDriveRequest } from "./drive";
import { cardKind } from "../remote/client";
import type { ApprovalRequest } from "./types";

describe("the drive card (872 step 5)", () => {
  it("knows its tool by the CLI's name and nothing near it", () => {
    expect(isDriveRequest(DRIVE_TOOL)).toBe(true);
    expect(isDriveRequest("mcp__nightloom__ask_user_to_drive_too")).toBe(false);
    expect(isDriveRequest("mcp__other__ask_user_to_drive")).toBe(false);
    expect(isDriveRequest("ask_user_to_drive")).toBe(false);
  });

  it("reads the model's one line, trimmed, or none", () => {
    expect(driveWhy({ why: "  Sign in to the bank  " })).toBe("Sign in to the bank");
    expect(driveWhy({ why: "   " })).toBeNull();
    expect(driveWhy({ why: 3 })).toBeNull();
    expect(driveWhy(null)).toBeNull();
  });

  it("hands back the page and his note over anything the model wrote", () => {
    const input = { why: "Sign in", handed_back: { url: "https://evil.example", title: "x", note: "all done" } };
    const got = handBackAnswer(input, { url: " https://bank.example/home ", title: " Accounts " }, "  signed in  ");
    expect(got).toEqual({
      why: "Sign in",
      handed_back: { url: "https://bank.example/home", title: "Accounts", note: "signed in" },
    });
    // The call's input is not changed.
    expect(input.handed_back.url).toBe("https://evil.example");
  });

  it("hands back with no page known and no note as empty words, still a hand-back", () => {
    expect(handBackAnswer({ why: "x" }, null, "")).toEqual({ why: "x", handed_back: { url: "", title: "", note: "" } });
    expect(handBackAnswer("not an object", undefined, "n")).toEqual({ handed_back: { url: "", title: "", note: "n" } });
  });

  it("keeps the card's state by chat and ask, so the same ask made again finds it", () => {
    const a = driveKey("c1", { why: "Sign in" }, "note");
    expect(a).toBe(driveKey("c1", { why: " Sign in " }, "note"));
    expect(a).not.toBe(driveKey("c2", { why: "Sign in" }, "note"));
    expect(a).not.toBe(driveKey("c1", { why: "Pay" }, "note"));
    expect(a).not.toBe(driveKey("c1", { why: "Sign in" }, "took"));
  });

  it("is its own card on the phone", () => {
    const req = { id: "t1", name: DRIVE_TOOL, input: { why: "Sign in" }, effect: "mutating" } as unknown as ApprovalRequest;
    expect(cardKind(req)).toBe("drive");
    expect(cardKind({ ...req, name: "mcp__nightloom__remember" })).toBe("call");
  });
});
