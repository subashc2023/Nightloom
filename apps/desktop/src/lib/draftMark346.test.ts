import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import { app } from "./state.svelte";
import * as tabs from "./tabs";
import { drafts, enqueueMessage, hasBoxDraft, hasDraft, newDraftKey, setDraftText } from "./drafts.svelte";
import Sidebar from "./Sidebar.svelte";
import TabStrip from "./TabStrip.svelte";
import type { SessionMeta } from "./types";

// Nightshift backlog 346 (a), seen in the 10/12 live check: while a message
// sat queued mid-turn (OTTER), chat A's tab and sidebar row said "has a
// draft" although the box was empty. The mark read `hasDraft`, which counts
// the queue. Now it reads `hasBoxDraft` — text or a chip in the box only.

vi.mock("./markdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./markdown")>()),
  renderMarkdown: (src: string) => `<div data-md>${src}</div>`,
}));

const project = { id: "p1", name: "P", root: "/tmp/p" } as unknown as typeof app.project;
const chat = (id: string, title: string): SessionMeta =>
  ({ id, title, modified: new Date(Date.UTC(2026, 9, 12, 12)).toISOString(), mode: "normal", kind: "build" }) as unknown as SessionMeta;

const MARK = /aria-label="has a draft"/g;
const marks = (html: string) => (html.match(MARK) ?? []).length;

function strip(): string {
  const pane = tabs.makePane([tabs.makeTab({ kind: "chat", session: "a" })]);
  app.tabs = { panes: [pane], focused: pane.id };
  return render(TabStrip, { props: { pane } }).body;
}

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  localStorage.clear();
  app.tabs = tabs.emptyWorkspace();
  app.project = project;
  app.view = "chat";
  app.leftTab = "chats";
  app.activeSessionId = "a";
  app.background = {};
  app.sessions = [chat("a", "Chat A")];
});

describe("backlog 346 (a): the draft mark is the box's, not the queue's", () => {
  it("a queued message alone earns no mark on the tab or the sidebar row", () => {
    enqueueMessage("a", "Also end your reply with the word OTTER.", []);
    expect(hasDraft("a")).toBe(true); // the queue is still kept and counted for the discard question
    expect(hasBoxDraft("a")).toBe(false);
    expect(marks(strip())).toBe(0);
    expect(marks(render(Sidebar).body)).toBe(0);
  });

  it("text in the box earns the mark, queue or not", () => {
    setDraftText("a", "half typed");
    expect(marks(strip())).toBe(1);
    expect(marks(render(Sidebar).body)).toBe(1);
    enqueueMessage("a", "held", []);
    expect(marks(strip())).toBe(1);
    expect(marks(render(Sidebar).body)).toBe(1);
  });

  it("the New chat row: a queue under the pending key earns no mark either", () => {
    app.activeSessionId = null;
    app.sessions = [];
    enqueueMessage(newDraftKey("p1", app.pendingMode), "held during the first turn", []);
    expect(marks(render(Sidebar).body)).toBe(0);
    setDraftText(newDraftKey("p1", app.pendingMode), "typed");
    expect(marks(render(Sidebar).body)).toBe(1);
  });
});
