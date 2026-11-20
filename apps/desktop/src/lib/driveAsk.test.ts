import { beforeEach, describe, expect, it, vi } from "vitest";
import cardSrc from "./DriveCard.svelte?raw";
import promptSrc from "./ApprovalPrompt.svelte?raw";
import viewSrc from "./ClaudeBrowserView.svelte?raw";
import remoteSrc from "../remote/Remote.svelte?raw";
import * as api from "./api";
import { app } from "./state.svelte";
import { browsers, resetBrowsers } from "./claudeBrowser.svelte";
import { DRIVE_TOOL } from "./drive";
import { driveNote, driveTook, handBack, pendingDrive, releasePage, setDriveNote, takePage } from "./driveAsk.svelte";
import { resetViewState } from "./viewState";
import * as tabs from "./tabs";
import type { ApprovalRequest } from "./types";
import type { BrowserStatus } from "./api";

/**
 * Nightshift item 872 step 5: the drive card's actions. The suite runs in
 * node, so the card is pinned through its actions (`driveAsk.svelte.ts`)
 * with the backend's commands stubbed, and — for what only the markup
 * holds — the components' source.
 */
const LIVE: BrowserStatus = {
  live: true,
  url: "https://bank.example/login",
  title: "Sign in",
  held_by: "model",
  width: 1280,
  height: 800,
  pages: 1,
};
let status: BrowserStatus | null = LIVE;
let holdFails: string | null = null;
let approveFails = false;

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  claudeBrowserWatch: vi.fn(async () => null),
  claudeBrowserHold: vi.fn(async (_s: string, held: boolean) => {
    if (holdFails) throw new Error(holdFails);
    status = { ...(status ?? LIVE), held_by: held ? "user" : "model" };
    return status;
  }),
  claudeBrowserStatus: vi.fn(async () => status),
  approveCall: vi.fn(async () => {
    if (approveFails) throw new Error("that prompt is no longer waiting: its turn has ended");
    return null;
  }),
}));

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({ id: "toolu_d1", name: DRIVE_TOOL, input: { why: "Sign in to the bank" }, effect: "mutating", chat: "s1", ...over }) as ApprovalRequest;

function ask(r = req()): ApprovalRequest {
  app.pendingApprovals.push(r);
  return r;
}

beforeEach(() => {
  status = LIVE;
  holdFails = null;
  approveFails = false;
  resetBrowsers();
  // A fresh store each test: what one ask kept must not reach the next.
  const kept = new Map<string, string>();
  resetViewState({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) });
  app.pendingApprovals.splice(0, app.pendingApprovals.length);
  app.toasts.splice(0, app.toasts.length);
  app.tabs = tabs.emptyWorkspace();
  vi.mocked(api.approveCall).mockClear();
  vi.mocked(api.claudeBrowserHold).mockClear();
});

describe("the drive card's actions (872 step 5)", () => {
  it("finds the ask waiting in a chat, and only a drive ask", () => {
    const r = ask();
    ask(req({ id: "x", name: "mcp__nightloom__remember", chat: "s1" }));
    expect(pendingDrive("s1")?.id).toBe(r.id);
    expect(pendingDrive("s2")).toBeNull();
  });

  it("Take control holds the browser for him and opens its tab", async () => {
    const r = ask();
    expect(await takePage(r)).toBeNull();
    expect(api.claudeBrowserHold).toHaveBeenCalledWith("s1", true);
    expect(browsers.byChat.s1?.held_by).toBe("user");
    expect(driveTook(r)).toBe(true);
    expect(tabs.findAnywhere(app.tabs, { kind: "browser", session: "s1" })).toBeTruthy();
    // Nothing was answered: the card still waits.
    expect(api.approveCall).not.toHaveBeenCalled();
    expect(app.pendingApprovals).toHaveLength(1);
  });

  it("with no browser nothing is taken, no tab opens, and he is told why", async () => {
    holdFails = "this chat has no browser";
    const r = ask();
    expect(await takePage(r)).toBe("Not taken: this chat has no browser.");
    expect(driveTook(r)).toBe(false);
    expect(tabs.findAnywhere(app.tabs, { kind: "browser", session: "s1" })).toBeFalsy();
  });

  it("Hand back gives the browser back and answers with the page and his note, then forgets them", async () => {
    const r = ask(req({ input: { why: "Sign in to the bank", handed_back: { url: "https://evil.example", note: "all done" } } }));
    setDriveNote(r, "  signed in, on Accounts ");
    await takePage(r);
    status = { ...LIVE, url: "https://bank.example/accounts", title: "Accounts", held_by: "user" };
    expect(await handBack(r)).toBeNull();
    expect(api.claudeBrowserHold).toHaveBeenLastCalledWith("s1", false);
    const sent = vi.mocked(api.approveCall).mock.calls[0];
    expect(sent.slice(0, 3)).toEqual(["toolu_d1", DRIVE_TOOL, "allow"]);
    expect(sent[4]).toEqual({
      why: "Sign in to the bank",
      handed_back: { url: "https://bank.example/accounts", title: "Accounts", note: "signed in, on Accounts" },
    });
    expect(app.pendingApprovals).toHaveLength(0);
    expect(driveNote(r)).toBe("");
    expect(driveTook(r)).toBe(false);
  });

  it("a browser that ended while he had it is handed back with no page claimed", async () => {
    const r = ask();
    holdFails = "this chat's browser is not running";
    status = null;
    expect(await handBack(r, "it crashed")).toBeNull();
    expect(vi.mocked(api.approveCall).mock.calls[0][4]).toEqual({
      why: "Sign in to the bank",
      handed_back: { url: "", title: "", note: "it crashed" },
    });
  });

  it("an answer that was not taken keeps his note", async () => {
    const r = ask();
    setDriveNote(r, "signed in");
    approveFails = true;
    expect(await handBack(r)).toContain("Your note is kept");
    expect(driveNote(r)).toBe("signed in");
    // The reply had ended: the same ask made again finds the note by chat and words, not by id.
    expect(driveNote(req({ id: "toolu_d2" }))).toBe("signed in");
  });

  it("Not now and Decline give the browser back only if he holds it", async () => {
    const r = ask();
    await releasePage(r);
    expect(api.claudeBrowserHold).not.toHaveBeenCalled();
    await takePage(r);
    await releasePage(r);
    expect(api.claudeBrowserHold).toHaveBeenLastCalledWith("s1", false);
    expect(browsers.byChat.s1?.held_by).toBe("model");
  });
});

describe("the drive card's markup (872 step 5)", () => {
  it("is the card ApprovalPrompt draws for the tool, before Playwright's", () => {
    const drive = promptSrc.indexOf("isDriveRequest(req.name)}");
    expect(drive).toBeGreaterThan(0);
    expect(drive).toBeLessThan(promptSrc.indexOf("isPlaywright(req.name)}"));
    expect(promptSrc).toContain("<DriveCard {req} />");
  });

  it("offers Take control, Hand back, Not now and Decline — never an Allow, an always, or a key that answers", () => {
    for (const act of ['data-act="take"', 'data-act="hand-back"', 'data-act="later"', 'data-act="decline"']) expect(cardSrc).toContain(act);
    expect(cardSrc).not.toMatch(/"always"|Allow/);
    expect(cardSrc).not.toContain("onkeydown");
    // Hand back shows only once he took the page.
    expect(cardSrc.indexOf("{#if took}")).toBeLessThan(cardSrc.indexOf('data-act="hand-back"'));
  });

  it("keeps his note as he types and reads it back when the card is drawn again", () => {
    expect(cardSrc).toContain("setDriveNote(req, note)");
    expect(cardSrc).toContain("note: driveNote(req)");
    expect(cardSrc).toContain("$state(start.note)");
  });

  it("the browser tab offers Hand back while the ask waits", () => {
    expect(viewSrc).toContain("pendingDrive(session)");
    expect(viewSrc).toContain("data-drive-ask");
    expect(viewSrc).toContain("handBack(driveReq)");
  });

  it("the phone's card can set it aside or decline, never allow", () => {
    const at = remoteSrc.indexOf('{:else if kind === "drive"}');
    const block = remoteSrc.slice(at, remoteSrc.indexOf('{:else if kind === "stuck"}'));
    expect(at).toBeGreaterThan(0);
    expect(block).toContain("DRIVE_PHONE");
    expect(block).toContain('answer(req, "later")');
    expect(block).toContain('answer(req, "deny"');
    expect(block).not.toContain('"allow"');
  });
});
