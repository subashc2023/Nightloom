import { describe, expect, it, vi } from "vitest";
import promptSource from "./ApprovalPrompt.svelte?raw";
import phoneSource from "../remote/Remote.svelte?raw";

/*
 * Nightshift item 743 (blocker 2029's default): the Mac's approval card gets the phone card's
 * "Not now — carry on", same words, sending the `later` reply the window's approve_call already takes
 * (commands/turns.rs: `Answer::Later` on the Claude Code engine, the set-aside refusal on the built-in one).
 */
const invoke = vi.fn(async (..._args: unknown[]) => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { app, resolveApproval } = await import("./state.svelte");

const LABEL = "Not now — carry on";

describe("743: Not now — carry on on the Mac's approval card", () => {
  it("both call cards (Claude Code's and the built-in engine's) carry the button, sending `later`", () => {
    const buttons = promptSource.match(/<button[^>]*data-act="later"[^>]*onclick=\{\(\) => decide\("later"\)\}>Not now — carry on<\/button>/g) ?? [];
    expect(buttons.length).toBe(2);
    expect(promptSource).toMatch(/decision: "allow" \| "always" \| "deny" \| "later"/);
  });

  it("the words are the phone card's", () => {
    expect(phoneSource).toContain(`>${LABEL}</button>`);
    expect(promptSource).toContain(`>${LABEL}</button>`);
  });

  it("answering `later` drops the card and sends approve_call with decision `later`", async () => {
    app.pendingApprovals.push({ id: "c1", name: "Bash", input: { command: "ls" }, effect: "mutating" } as never);
    invoke.mockClear();
    const ok = await resolveApproval("c1", "Bash", "later");
    expect(ok).toBe(true);
    expect(app.pendingApprovals.some((r) => r.id === "c1")).toBe(false);
    const call = invoke.mock.calls.find((c) => c[0] === "approve_call");
    expect(call).toBeDefined();
    expect((call![1] as { decision: string }).decision).toBe("later");
  });
});
