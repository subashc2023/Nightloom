// Item 845: the stage's pure parts — the tab row, Home's steps in plain words, the reply strip's exchange, Watch's
// source rows, and the kept state's reader.
import { describe, expect, it } from "vitest";
import { focusOf, tabsFor } from "./tabs";
import { lastExchange, stepsOf, toolNote, toolWords, type Ev } from "./steps";
import { sourceRows } from "./watch";
import { readKept } from "./stageState.svelte";
import { briefOf, sectionsOf } from "./brief";

const SCAN = "Morning scan — write today's Home page.";
const isScan = (t: string) => t.startsWith(SCAN);

describe("the tab row", () => {
  it("a blank Home chat is Watch alone — Home's own new-chat page", () => {
    expect(tabsFor({ blank: true, needs: 0 }).map((t) => t.id)).toEqual(["watch"]);
  });
  it("a chat with messages adds the Chat tab, last", () => {
    const more = [{ id: "brief", view: "brief" as const, name: "Brief", needs: 0, live: false }];
    expect(tabsFor({ blank: false, needs: 2, more }).map((t) => t.id)).toEqual(["watch", "brief", "chat"]);
    expect(tabsFor({ blank: false, needs: 2 })[0].needs).toBe(2);
  });
  it("focus stays where he left it, and falls back to Watch when that tab is gone", () => {
    const row = tabsFor({ blank: false, needs: 0 });
    expect(focusOf(row, "chat").id).toBe("chat");
    expect(focusOf(tabsFor({ blank: true, needs: 0 }), "chat").id).toBe("watch");
  });
});

describe("Home's steps", () => {
  const events: Ev[] = [
    { event: "user_message", text: "what needs me today?", at: "2026-11-18T10:00:00Z" },
    { event: "assistant_message", at: "2026-11-18T10:00:05Z", blocks: [{ type: "tool_use", name: "mcp__claude_ai_Gmail__search_threads", input: { query: "is:unread", token: "sk-secret" } }, { type: "tool_use", name: "chat_status", input: {} }, { type: "text", text: "Three things need you." }] },
  ];
  it("says each tool call in plain words, never its raw arguments", () => {
    const rows = stepsOf(events);
    expect(rows.map((r) => r.title)).toEqual(["You: what needs me today?", "Read your mail", "Checked what it routed", "Told you"]);
    expect(JSON.stringify(rows)).not.toContain("sk-secret");
    expect(rows[1].out).toBe("is:unread");
  });
  it("names an unknown tool by its bare name", () => {
    expect(toolWords("mcp__some_server__do_thing")[0]).toBe("Used do thing");
    expect(toolNote({ password: "x" })).toBe("");
  });
  it("keeps only the last turns, and calls the scan the scan", () => {
    const many: Ev[] = [{ event: "user_message", text: `${SCAN}\nfacts` }, ...events, { event: "user_message", text: "b" }, { event: "user_message", text: "c" }, { event: "user_message", text: "d" }];
    const rows = stepsOf(many, 3, isScan);
    expect(rows[0].title).toBe("You: b");
    expect(stepsOf(many, 9, isScan)[0].title).toBe("The morning scan started");
  });
});

describe("the reply strip", () => {
  it("shows his last message and Home's last words after it; the scan is not his message", () => {
    const ev: Ev[] = [{ event: "user_message", text: "hi", at: "a" }, { event: "assistant_message", blocks: [{ type: "text", text: "Hello." }] }, { event: "user_message", text: `${SCAN} x`, at: "b" }];
    expect(lastExchange(ev, isScan)).toEqual({ him: "hi", at: "a", home: "Hello." });
    expect(lastExchange([{ event: "user_message", text: "yo", at: "c" }])).toEqual({ him: "yo", at: "c", home: "" });
    expect(lastExchange([])).toBeNull();
  });
});

describe("Watch's sources", () => {
  it("one row per connector and per source this Mac has; what needs him is marked", () => {
    const rows = sourceRows(
      { checked_at: null, error: null, locals: [], accounts: [{ connector: "g", service: "Gmail", kind: "mail", address: null, nth: null, status: "needs_sign_in", on: true, claude_ai: true, in_scan: true }, { connector: "c", service: "Calendar", kind: "calendar", address: null, nth: null, status: "connected", on: false, claude_ai: true, in_scan: false }] },
      [{ id: "messages", name: "Messages", status: "denied", on: false, why: "You turned it down.", settings_url: "" }, { id: "contacts", name: "Contacts", status: "not_on_this_mac", on: false, why: "", settings_url: "" }] as never,
      (a) => a.service,
      (s) => (s === "connected" ? "Connected" : "Sign in again"),
    );
    expect(rows.map((r) => [r.name, r.state, r.hot])).toEqual([["Gmail", "Sign in again", true], ["Calendar", "off for Home", false], ["Messages · this Mac", "not allowed", true]]);
  });
});

describe("the kept stage", () => {
  it("reads what was saved and survives junk", () => {
    expect(readKept('{"focus":"chat","strip":"closed","stripFor":"x","ui":{"watch":{"open":"a"}}}')).toEqual({ focus: "chat", strip: "closed", stripFor: "x", ui: { watch: { open: "a" } } });
    expect(readKept("{nope").focus).toBe("watch");
    expect(readKept(null).strip).toBe("open");
  });
});

describe("the brief", () => {
  const page = "Three things need you.\n\n## Needs you\n- the lease\n- Mom\n\n**Handled**\n1. filed a receipt\n\n## Empty\n";
  it("cuts the page at its headings and counts each section's lines", () => {
    expect(sectionsOf(page).map((s) => [s.title, s.lines])).toEqual([["Summary", 0], ["Needs you", 2], ["Handled", 1]]);
  });
  it("is the newest scan's page; writing only while that turn runs", () => {
    const ev: Ev[] = [{ event: "user_message", text: `${SCAN}\nfacts`, at: "t" }, { event: "assistant_message", blocks: [{ type: "tool_use", name: "Read" }, { type: "text", text: page }] }];
    expect(briefOf(ev, isScan, true)).toMatchObject({ at: "t", writing: true });
    expect(briefOf(ev, isScan, true)!.sections).toHaveLength(3);
    expect(briefOf([...ev, { event: "user_message", text: "thanks" }], isScan, true)!.writing).toBe(false);
    expect(briefOf([{ event: "user_message", text: "hi" }], isScan, false)).toBeNull();
  });
});
