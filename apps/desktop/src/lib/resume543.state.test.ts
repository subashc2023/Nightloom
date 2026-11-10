import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 543a (his words, backlog/543): "once that entire thing is done, then
// I need it to schedule again for five hours after that in case it runs
// out." The real `state.svelte.ts` with only the backend scripted, as
// `schedule535.state.test.ts` does: two chats paused by the limit both
// resume, off screen, in their own projects; a resumed turn that runs into
// the next window's limit resumes again at the next reset, with no click.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  canSendInChat: vi.fn(async () => null),
  reserveChatAgent: vi.fn(async () => true),
  armWake: vi.fn(async () => null),
  scheduleLog: vi.fn(async () => null),
  transcript: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  openSession: vi.fn(async () => {
    throw new Error("a resume must not open a chat");
  }),
  planUsage: vi.fn(async () => null),
  notify: vi.fn(async () => null),
  continueChat: vi.fn(async () => "chat-next"),
  continueSession: vi.fn(async () => ({ session: "chat-next", events: [], forked: true })),
  idleSeconds: vi.fn(async () => 0),
}));

const api = await import("./api");
const { app, clearResumes, limitWakeDue, resumeAfterLimit, resumes, sendInChat } = await import("./state.svelte");
const { RESUME_MARGIN_MS } = await import("./limit");
const { RESUMES_KEY, readResumes } = await import("./chatResume");
const { noteActivity, isUnattended, setMarkAt, NEVER } = await import("./handoff.svelte");
const { readDraft } = await import("./drafts.svelte");

const COLLEGE = { id: "p-college", name: "College" };
const VALUE = { id: "p-value", name: "Value generalization" };
const A = "chat-a";
const B = "chat-b";
const OTHER = "chat-on-screen";

const send = vi.mocked(api.sendAgent);
/** Each started turn's resolver, by the chat the backend was told. */
const turns = new Map<string, (r: unknown) => void>();

function look(chat: string | null, project: { id: string; name: string }) {
  app.activeSessionId = chat;
  app.project = project as never;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

const ok = { delivered: [], notices: [], is_error: false, refused: [], limit: null };
const limited = (resetsAtMs: number) => ({
  ...ok,
  limit: { resets_at: resetsAtMs / 1000, window: "five_hour", text: "You've hit your session limit", subagents: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  clearResumes();
  turns.clear();
  for (const k of Object.keys(app.background)) delete app.background[k];
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as never;
  app.connecting = false;
  app.busy = false;
  app.error = null;
  app.toasts = [];
  app.sessions = [];
  app.events = [];
  app.limitPause = null;
  app.limitResumeAt = null;
  send.mockReset();
  send.mockImplementation(((...args: unknown[]) => {
    const target = args[7] as { chat: string } | undefined;
    return new Promise((r) => turns.set(target?.chat ?? "screen", r));
  }) as never);
});

describe("543a — every paused chat resumes, at every reset", () => {
  it("two chats paused off screen by the limit: each has its own entry and both resume at the reset, in their own projects", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 3600_000;
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "work a", [], () => {});
      sendInChat(B, VALUE, "work b", [], () => {});
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
      turns.get(A)!(limited(reset));
      turns.get(B)!(limited(reset));
      await settle();
      // Both are kept — before 543 the slot held one, and an off-screen pause none.
      expect(Object.keys(resumes).sort()).toEqual([A, B]);
      expect(resumes[A].at).toBe(reset + RESUME_MARGIN_MS);
      expect(resumes[A].project).toEqual(COLLEGE);
      expect(resumes[B].project).toEqual(VALUE);
      expect(api.armWake).toHaveBeenLastCalledWith("limit", reset + RESUME_MARGIN_MS);
      // Kept across a relaunch.
      expect(Object.keys(readResumes(localStorage.getItem(RESUMES_KEY))).sort()).toEqual([A, B]);
      // The chat on screen is neither: no card there.
      expect(app.limitPause).toBeNull();

      // Before the time nothing goes.
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(2);

      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      limitWakeDue(); // the backend's event
      limitWakeDue(); // and its repeat
      await settle();
      expect(send).toHaveBeenCalledTimes(4);
      const resumed = send.mock.calls.slice(2).map((c) => [c[0], c[7]]);
      expect(resumed).toEqual(
        expect.arrayContaining([
          [expect.stringMatching(/^The last turn was paused by the plan's usage limit/), { chat: A, project: "p-college" }],
          [expect.stringMatching(/^The last turn was paused by the plan's usage limit/), { chat: B, project: "p-value" }],
        ]),
      );
      expect(Object.keys(resumes)).toEqual([]);
      expect(api.armWake).toHaveBeenLastCalledWith("limit", null);
      // His view never moved.
      expect([app.activeSessionId, app.project?.id]).toEqual([OTHER, "p-value"]);
      expect(api.openSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a resumed turn that hits the next window's limit resumes again at the next reset — two successive resets, no click", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset1 = Date.now() + 3600_000;
      const reset2 = reset1 + 5 * 3600_000;
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "a long job", [], () => {});
      await settle();
      turns.get(A)!(limited(reset1));
      await settle();

      vi.setSystemTime(reset1 + RESUME_MARGIN_MS + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
      // The resumed turn runs out again: the next entry, by itself.
      turns.get(A)!(limited(reset2));
      await settle();
      expect(resumes[A]?.at).toBe(reset2 + RESUME_MARGIN_MS);

      vi.setSystemTime(reset2 + RESUME_MARGIN_MS + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]![7]).toEqual({ chat: A, project: "p-college" });
      // This one finishes: the work is done, nothing is armed.
      turns.get(A)!(ok);
      await settle();
      expect(resumes[A]).toBeUndefined();
      expect(api.armWake).toHaveBeenLastCalledWith("limit", null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an entry that cannot go yet is kept and asked again; one whose chat is gone is dropped", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 3600_000;
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "work a", [], () => {});
      sendInChat(B, COLLEGE, "work b", [], () => {});
      await settle();
      turns.get(A)!(limited(reset));
      turns.get(B)!(limited(reset));
      await settle();
      vi.mocked(api.canSendInChat).mockImplementation(async (chat: string) => {
        throw new Error(chat === A ? "its project is not open" : "its chat's log could not be read");
      });
      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
      expect(resumes[A]?.note).toMatch(/its project is not open/);
      expect(resumes[B]).toBeUndefined();
      // The clock stays armed for it, so it is asked again (every 15 s).
      expect(api.armWake).toHaveBeenLastCalledWith("limit", reset + RESUME_MARGIN_MS);
      vi.mocked(api.canSendInChat).mockImplementation(async () => null);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(3);
      expect(resumes[A]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cancel on the card stops the chat's own resume and no other's; Resume sets it again", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 3600_000;
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "work a", [], () => {});
      sendInChat(B, COLLEGE, "work b", [], () => {});
      await settle();
      turns.get(A)!(limited(reset));
      turns.get(B)!(limited(reset));
      await settle();
      // He opens chat A: its card, with its time.
      look(A, COLLEGE);
      resumeAfterLimit(); // a pause on `app` is read from the entry once shown
      expect(app.limitPause).toBeNull(); // nothing shown yet in this suite (no effect runs in node)
      app.limitPause = resumes[A].pause;
      app.limitResumeAt = resumes[A].at;
      resumeAfterLimit(); // Cancel
      expect(resumes[A].at).toBeNull();
      expect(app.limitResumeAt).toBeNull();
      expect(resumes[B].at).toBe(reset + RESUME_MARGIN_MS);
      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      limitWakeDue();
      await settle();
      // B went; A waits for his click.
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]![7]).toEqual({ chat: B, project: "p-college" });
      expect(resumes[A]).toBeDefined();
      resumeAfterLimit(); // Resume, after the reset: at once, in the chat on screen
      await settle();
      expect(send).toHaveBeenCalledTimes(4);
      expect(send.mock.calls[3]![7]).toEqual({ chat: A, project: "p-college" });
      expect(resumes[A]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("review 535-2: the on-screen resume names its chat — he switches chats while it waits to start, and it still runs in the paused chat", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 3600_000;
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "work a", [], () => {});
      await settle();
      turns.get(A)!(limited(reset));
      await settle();
      look(A, COLLEGE); // the paused chat is the one on screen at its time
      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      limitWakeDue();
      look(OTHER, VALUE); // and he leaves before the turn has started
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0]).toMatch(/^The last turn was paused by the plan's usage limit/);
      // ~~`sendUntyped`, no chat id~~: the backend is told the chat, so it cannot land in another.
      expect(send.mock.calls[1]![7]).toEqual({ chat: A, project: "p-college" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("543a — his report of 6:30 AM: helpers hit the limit, the chat went silent, then a Resume button he had to click", () => {
  // The backend now ends such a turn by itself (`LIMIT_GRACE`, agent/mod.rs) with the
  // limit on its result and this notice; here: what the window does with that result.
  const helpers = (resetsAtMs: number) => ({
    ...ok,
    notices: ["paused — the plan's usage limit stopped the helpers this turn was waiting on"],
    limit: {
      resets_at: resetsAtMs / 1000,
      window: "five_hour",
      text: "You've hit your usage limit",
      subagents: [],
      agents: [{ tool_use_id: "toolu_HELPER", agent_id: "a8bb", description: "funding scan", status: "running" }],
    },
  });

  it("on screen: the card shows at once with its time already set — no button to press — and it resumes at the reset, naming the helper", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 4 * 3600_000;
      look(A, COLLEGE); // the College chat, on screen, as his was
      sendInChat(A, COLLEGE, "run the seven research slices", [], () => {});
      await settle();
      expect(send).toHaveBeenCalledTimes(1);
      turns.get(A)!(helpers(reset));
      await settle();
      // Paused, shown, and scheduled — all at the turn's end.
      expect(app.busy).toBe(false);
      expect(app.limitPause?.session).toBe(A);
      expect(app.limitPause?.agents.map((a) => a.agent_id)).toEqual(["a8bb"]);
      expect(app.limitResumeAt).toBe(reset + RESUME_MARGIN_MS); // the card reads "will resume at …", not a Resume button
      expect(api.armWake).toHaveBeenLastCalledWith("limit", reset + RESUME_MARGIN_MS);

      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      limitWakeDue(); // nobody clicked anything
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0]).toMatch(/^The last turn was paused by the plan's usage limit/);
      expect(send.mock.calls[1]![0]).toContain("`a8bb` (funding scan");
      expect(send.mock.calls[1]![7]).toEqual({ chat: A, project: "p-college" });
      expect(app.limitPause).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("off screen: the same, with no card to click at all", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 4 * 3600_000;
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "run the seven research slices", [], () => {});
      await settle();
      turns.get(A)!(helpers(reset));
      await settle();
      expect(resumes[A]?.at).toBe(reset + RESUME_MARGIN_MS);
      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0]).toContain("`a8bb` (funding scan");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("543b — a chat that stops short of the limit and asks is continued after the reset", () => {
  /** The reply of the turn running off screen in `chat`. */
  function says(chat: string, text: string) {
    app.background[chat]!.live = { segments: [{ kind: "text", text }] } as never;
  }

  it("at two successive resets, unattended; a reply with no ask ends it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const iso = (ms: number) => new Date(ms).toISOString();
      const reset1 = Date.now() + 1800_000;
      const reset2 = reset1 + 5 * 3600_000;
      app.planUsage = { five_hour: 95, seven_day: 40, five_hour_resets_at: iso(reset1), seven_day_resets_at: null } as never;
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "the whole queue", [], () => {});
      await settle();
      // It stops itself at 95% — a normal end, no limit pause — and asks.
      says(A, 'Parked at 95% of the window.\n\n<continue-later at="reset">wave B, then the review</continue-later>');
      turns.get(A)!(ok);
      await settle();
      expect(resumes[A]?.why).toBe("asked");
      expect(resumes[A]?.at).toBe(reset1 + 60_000);
      expect(resumes[A]?.project).toEqual(COLLEGE);
      expect(api.armWake).toHaveBeenLastCalledWith("limit", reset1 + 60_000);
      expect(api.reserveChatAgent).toHaveBeenCalledWith(A, true);

      vi.setSystemTime(reset1 + 60_000 + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0]).toMatch(/^\[Nightloom, not from Swaraag: you asked to be continued/);
      expect(send.mock.calls[1]![0]).toContain("wave B, then the review");
      expect(send.mock.calls[1]![7]).toEqual({ chat: A, project: "p-college" });
      expect(resumes[A]).toBeUndefined();

      // The continued turn runs to 95% of the next window and asks again.
      app.planUsage = { five_hour: 95, seven_day: 45, five_hour_resets_at: iso(reset2), seven_day_resets_at: null } as never;
      says(A, 'Again at 95%.\n\n<continue-later at="reset">the review</continue-later>');
      turns.get(A)!(ok);
      await settle();
      expect(resumes[A]?.at).toBe(reset2 + 60_000);
      vi.setSystemTime(reset2 + 60_000 + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]![0]).toContain("the review");

      // The third turn finishes the work and asks nothing: nothing is armed.
      says(A, "All done.");
      turns.get(A)!(ok);
      await settle();
      expect(resumes[A]).toBeUndefined();
      expect(api.armWake).toHaveBeenLastCalledWith("limit", null);
      expect([app.activeSessionId, app.project?.id]).toEqual([OTHER, "p-value"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("543m review: a turn that runs in the chat before the ask's time ends the ask — no stale continue hours later", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "the whole queue", [], () => {});
      await settle();
      says(A, '<continue-later at="+2h">wave B</continue-later>');
      turns.get(A)!(ok);
      await settle();
      expect(resumes[A]?.why).toBe("asked");
      const at = resumes[A]!.at as number;
      // He sends there himself an hour later; that turn ends asking nothing.
      vi.setSystemTime(Date.now() + 3600_000);
      sendInChat(A, COLLEGE, "do wave B now", [], () => {});
      await settle();
      says(A, "Wave B is done.");
      turns.get(A)!(ok);
      await settle();
      expect(resumes[A]).toBeUndefined();
      expect(api.armWake).toHaveBeenLastCalledWith("limit", null);
      // The ask's time passes: nothing is sent.
      vi.setSystemTime(at + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed turn's reply asks nothing; a limit pause wins over an ask in the same reply", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 3600_000;
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "x", [], () => {});
      sendInChat(B, COLLEGE, "y", [], () => {});
      await settle();
      says(A, '<continue-later at="+10m">again</continue-later>');
      turns.get(A)!({ ...ok, is_error: true });
      says(B, '<continue-later at="+10m">again</continue-later>');
      turns.get(B)!(limited(reset));
      await settle();
      expect(resumes[A]).toBeUndefined();
      expect(resumes[B]?.why).toBe("limit");
      expect(resumes[B]?.at).toBe(reset + RESUME_MARGIN_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("544 — an unattended chat hands off by itself; with him present the card waits", () => {
  const HANDOFF = "HANDOFF.md is written.\n\n<handoff>\nRead HANDOFF.md, then run wave B.\n</handoff>\n";
  function says(chat: string, text: string) {
    app.background[chat]!.live = { segments: [{ kind: "text", text }] } as never;
  }

  it("away, off screen: the next linked chat is started where the chat lives and its prompt sent — no click, the view untouched", async () => {
    noteActivity(Date.now() - 600_000); // nothing typed for ten minutes
    look(OTHER, VALUE);
    sendInChat(A, COLLEGE, "wrap up", [], () => {});
    await settle();
    says(A, HANDOFF);
    turns.get(A)!(ok);
    await settle();
    expect(api.continueChat).toHaveBeenCalledWith(A, "p-college");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toBe("Read HANDOFF.md, then run wave B.");
    expect(send.mock.calls[1]![7]).toEqual({ chat: "chat-next", project: "p-college" });
    expect(app.background["chat-next"]?.project).toBe("p-college");
    // The new chat inherits the unattended state: its own pause, ask and hand-off go by themselves.
    expect(isUnattended("chat-next")).toBe(true);
    expect([app.activeSessionId, app.project?.id]).toEqual([OTHER, "p-value"]);
    expect(api.openSession).not.toHaveBeenCalled();
    // And it does so once: the same reply read again continues nothing.
    turns.get("chat-next")!(ok);
    await settle();
    expect(api.continueChat).toHaveBeenCalledTimes(1);
  });

  it("the new chat's own limit pause resumes by itself (the chain holds across the hand-off)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      noteActivity(Date.now() - 600_000);
      const reset = Date.now() + 3600_000;
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "wrap up", [], () => {});
      await settle();
      says(A, HANDOFF);
      turns.get(A)!(ok);
      await settle();
      turns.get("chat-next")!(limited(reset));
      await settle();
      expect(resumes["chat-next"]?.at).toBe(reset + RESUME_MARGIN_MS);
      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]![7]).toEqual({ chat: "chat-next", project: "p-college" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("present (he typed a moment ago): nothing is continued — the card waits for his click", async () => {
    noteActivity(Date.now());
    look(OTHER, VALUE);
    sendInChat(A, COLLEGE, "wrap up", [], () => {});
    await settle();
    says(A, HANDOFF);
    turns.get(A)!(ok);
    await settle();
    expect(api.continueChat).not.toHaveBeenCalled();
    expect(api.continueSession).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the window in front on that chat, but the Mac untouched for ten minutes: it continues on screen through the card's own path", async () => {
    noteActivity(Date.now() - 600_000);
    vi.mocked(api.idleSeconds).mockImplementation(async () => 900);
    look(OTHER, VALUE);
    sendInChat(A, COLLEGE, "wrap up", [], () => {});
    await settle();
    says(A, HANDOFF);
    look(A, COLLEGE); // he left this chat open, in front
    turns.get(A)!(ok);
    await settle();
    expect(api.continueSession).toHaveBeenCalledTimes(1);
    expect(api.continueChat).not.toHaveBeenCalled();
    expect(app.activeSessionId).toBe("chat-next");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toBe("Read HANDOFF.md, then run wave B.");
  });

  it("545: a chat whose mark is never is not continued by Nightloom, away or not", async () => {
    noteActivity(Date.now() - 600_000);
    setMarkAt("chat", A, NEVER);
    try {
      look(OTHER, VALUE);
      sendInChat(A, COLLEGE, "wrap up", [], () => {});
      await settle();
      says(A, HANDOFF);
      turns.get(A)!(ok);
      await settle();
      expect(api.continueChat).not.toHaveBeenCalled();
      expect(readDraft(A).queue).toEqual([]);
    } finally {
      setMarkAt("chat", A, null);
    }
  });

  it("a hand-off that cannot start off screen is not lost: nothing is sent and the next end tries again", async () => {
    noteActivity(Date.now() - 600_000);
    vi.mocked(api.continueChat).mockImplementationOnce(async () => {
      throw new Error("its project is not open");
    });
    look(OTHER, VALUE);
    sendInChat(A, COLLEGE, "wrap up", [], () => {});
    await settle();
    says(A, HANDOFF);
    turns.get(A)!(ok);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
