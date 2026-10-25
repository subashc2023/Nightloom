import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import type { ClaudeAuthStatus, SessionEvent } from "./types";

// Nightshift backlog 409: a signed-out Claude Code is detected, the stand-in
// reply says so with Sign in, and Sign in types the CLI's login by its
// absolute path into a new terminal tab.

// The backend as far as sign-in reaches it: the status, and the keystrokes.
let status: ClaudeAuthStatus;
const typed: [number, string][] = [];
const asked: (string | null)[] = [];
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  claudeAuthStatus: vi.fn(async (binary: string | null) => {
    asked.push(binary);
    return status;
  }),
  terminalWrite: vi.fn(async (id: number, data: string) => {
    typed.push([id, data]);
    return null;
  }),
}));
// The shell itself: a row, opened where it was asked to.
const opened: (string | null | undefined)[] = [];
let shellOpens = true;
vi.mock("./terminal.svelte", async (orig) => ({
  ...(await orig<typeof import("./terminal.svelte")>()),
  newShell: vi.fn(async (_pane: string | null | undefined, at?: string | null) => {
    opened.push(at);
    return shellOpens ? { id: 7, pid: 1, shell: "zsh", title: "zsh", exit: null, pane: "main" } : null;
  }),
}));

import { app } from "./state.svelte";
import { chipWord, loginCommand, phaseLine, shellQuote } from "./claudeAuth";
import { auth, probeAuth, probeSoon, resetAuthForTest, signIn } from "./claudeAuth.svelte";
import { isSignedOut, isStandIn, signedOutDetail, stopNote } from "./replyFooter";
import { endsTurn, retryPrompt } from "./retry";
import SignedOutNotice from "./SignedOutNotice.svelte";

// The exact line he saw (2.1.310), as the service records it.
const CLI_SAYS = "Failed to authenticate: OAuth session expired and could not be refreshed";
const REASON = `error: signed out: ${CLI_SAYS}`;
const STAND_IN = `No reply: ${CLI_SAYS}`;
const CLI = "/Users/me/.local/share/claude/versions/2.1.310";

beforeEach(() => {
  resetAuthForTest();
  typed.length = 0;
  asked.length = 0;
  opened.length = 0;
  shellOpens = true;
  status = { binary: CLI, signed_in: false, home: "/Users/me" };
  app.connection = null;
});

describe("the detector (the service's mark on the stop reason)", () => {
  it("reads the signed-out stop and its sentence", () => {
    expect(isSignedOut(REASON)).toBe(true);
    expect(signedOutDetail(REASON)).toBe(CLI_SAYS);
    expect(stopNote(REASON)).toBe("stopped · Claude Code is signed out");
    // Still a stand-in (backlog 407): drawn as Nightloom's, not the model's.
    expect(isStandIn([STAND_IN], REASON)).toBe(true);
  });

  it("leaves every other stop alone", () => {
    for (const r of ["error: overloaded", `error: ${CLI_SAYS}`, "stopped", "end_turn", null, undefined]) {
      expect(isSignedOut(r)).toBe(false);
      expect(signedOutDetail(r)).toBe("");
    }
    expect(stopNote("error: overloaded")).toBe("stopped · overloaded");
  });
});

describe("the login line", () => {
  it("is the absolute CLI, quoted, then auth login", () => {
    expect(loginCommand(CLI)).toBe(`'${CLI}' auth login`);
    expect(loginCommand("/Apps/My Tools/claude")).toBe(`'/Apps/My Tools/claude' auth login`);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("the chip says signed out only when the status did", () => {
    expect(chipWord(false)).toBe("signed out");
    expect(chipWord(true)).toBeNull();
    expect(chipWord(null)).toBeNull();
  });
});

describe("probe and Sign in", () => {
  it("a probe sets the state and asks with the connected binary", async () => {
    app.connection = { engine: "claude-code", agent: { binary: "/x/claude" } } as unknown as typeof app.connection;
    await probeAuth();
    expect(asked).toEqual(["/x/claude"]);
    expect(auth.signedIn).toBe(false);
    expect(auth.binary).toBe(CLI);
  });

  it("a notice mounting asks at most every 30 s", async () => {
    probeSoon(1_000_000);
    await Promise.resolve();
    const n = asked.length;
    probeSoon(auth.probedAt + 5_000);
    expect(asked.length).toBe(n);
    probeSoon(auth.probedAt + 31_000);
    expect(asked.length).toBe(n + 1);
  });

  it("opens a tab in home (no project folder) and types the login with Enter", async () => {
    expect(await signIn()).toBe(true);
    expect(opened).toEqual(["/Users/me"]);
    expect(typed).toEqual([[7, `'${CLI}' auth login\r`]]);
    expect(auth.phase).toBe("typed");
  });

  it("says when the status turns signed in", async () => {
    await signIn();
    status = { ...status, signed_in: true };
    await probeAuth();
    expect(auth.phase).toBe("signed-in");
    expect(auth.signedIn).toBe(true);
  });

  it("a tab that will not open is a failure the notice shows the line for", async () => {
    shellOpens = false;
    expect(await signIn()).toBe(false);
    expect(auth.phase).toBe("failed");
    expect(typed).toEqual([]);
  });
});

describe("Retry on a signed-out reply (item 333)", () => {
  it("finds his message and the reply ends the turn", () => {
    const at = "2026-10-24T00:00:00Z";
    const events: SessionEvent[] = [
      { event: "user_message", text: "hello", at },
      {
        event: "assistant_message",
        model: "claude-opus-5-5",
        blocks: [{ type: "text", text: STAND_IN }],
        stop_reason: REASON,
        usage: { input_tokens: 0, output_tokens: 0 },
        at,
      } as SessionEvent,
    ];
    expect(retryPrompt(events, 1)).toMatchObject({ index: 0, text: "hello" });
    expect(endsTurn([{ kind: "user", superseded: false }, { kind: "assistant", superseded: false }])).toEqual([false, true]);
  });
});

describe("the notice's states", () => {
  const html = () => render(SignedOutNotice, { props: { reason: REASON } }).body;

  it("idle: the title, the line, Sign in, and the CLI's sentence", () => {
    const h = html();
    expect(h).toContain("Claude Code is signed out");
    expect(h).toContain(phaseLine("idle"));
    expect(h).toMatch(/>\s*Sign in\s*</);
    expect(h).toContain(CLI_SAYS);
    expect(h).not.toContain("<code");
  });

  it("typed: tells him to finish in the terminal, then Retry", () => {
    auth.phase = "typed";
    const h = html();
    expect(h).toContain(phaseLine("typed"));
    expect(h).toMatch(/>\s*Sign in again\s*</);
  });

  it("signed in: says so", () => {
    auth.phase = "signed-in";
    expect(html()).toContain(phaseLine("signed-in"));
  });

  it("failed: shows the line to run", () => {
    auth.phase = "failed";
    auth.binary = CLI;
    const h = html();
    expect(h).toContain(phaseLine("failed"));
    expect(h).toContain(`<code class="cmd`);
    expect(h).toContain(`auth login`);
  });

  it("opening: the button waits", () => {
    auth.phase = "opening";
    expect(html()).toMatch(/<button[^>]*disabled/);
  });
});
