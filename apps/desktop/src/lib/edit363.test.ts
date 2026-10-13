import { describe, expect, it, vi } from "vitest";

/*
 * Nightshift item 363, his workflow: send a short first message to name the
 * chat, Stop at once, then edit that message in the transcript, adding the
 * files, and press Enter. Edit and send forks before the first turn (the
 * service keeps the name and starts a fresh CLI conversation; Rust tests in
 * chat_ops.rs). This checks the window's half: the fork opens and the edited
 * words go out with the documents and files the edit box held.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  editMessage: vi.fn(async () => ({
    events: [
      { event: "session_created", at: "2026-10-13T21:15:00Z", kind: "study", mode: "normal" },
      { event: "title", text: "Lecture 4 & 5", by: "user", at: "2026-10-13T21:15:00Z" },
    ],
    session: "fork-363",
    forked: true,
  })),
  sendAgent: vi.fn(async () => {
    throw "stop here";
  }),
  listSessions: vi.fn(async () => []),
}));

import { app, sendEdit } from "./state.svelte";
import * as api from "./api";

describe("item 363: edit a stopped first message and send", () => {
  it("forks, opens the fork, and sends the edited words with the files", async () => {
    app.connection = { engine: "claude-code" } as typeof app.connection;
    app.busy = false;
    app.activeSessionId = "parent-363";
    app.events = [
      { event: "session_created", id: "parent-363", at: "2026-10-13T21:12:53Z" } as never,
      { event: "user_message", text: "Lecture 4 & 5", at: "2026-10-13T21:12:53Z" } as never,
    ];
    const docs = [{ media_type: "application/pdf", name: "lecture4.pdf", data: "JVBE" }] as never[];
    const files = [{ name: "lecture5.pdf", path: "/tmp/lecture5.pdf" }] as never[];
    const forked: [string | null, string][] = [];
    await sendEdit(1, "Alright let's go through lecture 4.", [], docs, (p, f) => forked.push([p, f]), files);

    expect(api.editMessage).toHaveBeenCalledWith(1, "Alright let's go through lecture 4.", "send");
    expect(forked).toEqual([["parent-363", "fork-363"]]);
    expect(app.activeSessionId).toBe("fork-363");
    await vi.waitFor(() => expect(api.sendAgent).toHaveBeenCalledTimes(1));
    const call = vi.mocked(api.sendAgent).mock.calls[0];
    expect(call[0]).toBe("Alright let's go through lecture 4.");
    expect(call[2]).toEqual(docs);
    expect(call[6]).toEqual(files);
  });
});
