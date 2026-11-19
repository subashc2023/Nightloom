// Item 845 batch 2: Browse, Run and Research read Home's task data defensively; Brief's note and speech text;
// Watch's per-source check time; the stage draws all three task views.
import { describe, expect, it } from "vitest";
import { browseOf, runOf, researchOf, noteName, researchNote } from "./taskData";
import { briefNote, sectionsOf, speakable } from "./brief";
import { sourceRows } from "./watch";
import stageSrc from "./Stage.svelte?raw";
import watchSrc from "./views/Watch.svelte?raw";
import briefSrc from "./views/Brief.svelte?raw";
import browseSrc from "./views/Browse.svelte?raw";
import desktopHostSrc from "./desktopHost.ts?raw";

describe("browse", () => {
  it("reads the page, its fields and a hold; drops the wrong types", () => {
    const b = browseOf({ url: "permits.example/renew", page: "Renew a permit", fields: [{ label: "Permit", value: "RP-1" }, { value: "no label" }, 7], hold: { what: "Pay the renewal", amount: "$84.00", to: "City" } });
    expect(b.url).toBe("permits.example/renew");
    expect(b.fields).toEqual([{ label: "Permit", value: "RP-1" }]);
    expect(b.hold).toMatchObject({ what: "Pay the renewal", amount: "$84.00", to: "City", from: "" });
    expect(browseOf({ hold: { amount: "$1" } }).hold).toBeNull();
    expect(browseOf(null)).toMatchObject({ url: "", fields: [], hold: null });
  });
  it("shows the live picture only when the chat has the app's browser", () => {
    // 845 batch 3: the check and the picture are the host's (the Mac's window: desktopHost.ts); the phone has neither.
    expect(desktopHostSrc).toContain('phase(s) !== "none"');
    expect(desktopHostSrc).toContain("BrowserView: ClaudeBrowserView");
    expect(browseSrc).toContain("<BrowserView {session} />");
  });
  it("draws the hold (kind C) in the main column when the stage is narrow, where the wide column is not drawn", () => {
    expect(browseSrc).toContain('{#if b.hold}<div class="w-narrow">{@render holdCard()}</div>{/if}');
    expect(browseSrc).toContain(":global(.h9-stage.narrow) .w-narrow { display: contents; }");
  });
});

describe("run", () => {
  it("reads steps, helpers and the log's last lines", () => {
    const r = runOf({ title: "Merge round T", steps: [{ id: "f", name: "Fetch", state: "done", out: "3 branches" }, { name: "Checks", state: "live", progress: 45 }, { name: "Build", state: "bogus" }, { state: "done" }], agents: [{ name: "merger", state: "live", tokens: 182.4 }], log: Array.from({ length: 50 }, (_, i) => `line ${i}`), chat: "c1" });
    expect(r.steps.map((s) => [s.name, s.state])).toEqual([["Fetch", "done"], ["Checks", "live"], ["Build", "wait"]]);
    expect(r.steps[1].progress).toBeCloseTo(0.45);
    expect(r.agents[0].tokens).toBe(182);
    expect(r.log).toHaveLength(40);
    expect(r.log.at(-1)).toBe("line 49");
    expect(runOf("x")).toMatchObject({ steps: [], agents: [], log: [], chat: "" });
  });
});

describe("research", () => {
  const data = {
    question: "Which cache pays?",
    sources: [{ id: "s1", site: "docs.example", title: "Pricing", state: "kept" }, { id: "s2", site: "blog.example", title: "Tricks", state: "dropped", why: "no figures" }, { id: "s3", title: "Your note", own: true, state: "reading" }],
    claims: [{ id: "c1", src: "s1", text: "A 1-hour write costs 2×." }, { id: "c2", src: "s3", text: "It paid back after two follow-ups." }],
    answer: [{ text: "The 1-hour cache pays after minute 5.", cites: ["c1", "c2"] }, "A plain line."],
    open: ["Does a read refresh the hour?", { text: "Gemini's price", answered: "by claim 1" }],
    done: true,
  };
  it("reads sources, claims, the answer and open questions", () => {
    const r = researchOf(data);
    expect(r.sources.map((s) => s.state)).toEqual(["kept", "dropped", "reading"]);
    expect(r.sources[2].own).toBe(true);
    expect(r.answer[1]).toEqual({ text: "A plain line.", cites: [] });
    expect(r.open[1].answered).toBe("by claim 1");
    expect(r.done).toBe(true);
  });
  it("keeps as a note without a source he dropped, and never over a name he has", () => {
    const md = researchNote(researchOf(data), { s1: true });
    expect(md).toContain("# Which cache pays?");
    expect(md).not.toContain("2×");
    expect(md).toContain("1. It paid back after two follow-ups.");
    expect(md).toContain("[1]");
    expect(noteName("Research — a/b: c?", [])).toBe("Research — a b c.md");
    expect(noteName("Brief", ["brief.md", "Brief (2).md"])).toBe("Brief (3).md");
  });
});

describe("brief", () => {
  it("speaks plain words and keeps the page under its headings", () => {
    expect(speakable("- **Lease** — reply by [Friday](x)\n- Mom asked")).toBe("Lease — reply by Friday. Mom asked");
    const b = { at: "2026-11-19T08:00:00Z", asked: "", writing: false, sections: sectionsOf("Intro.\n\n## Today\n- 9:00 AM stand-up") };
    const md = briefNote(b, "Thursday, 8:00 AM");
    expect(md.startsWith("# Morning brief — Thursday, 8:00 AM")).toBe(true);
    expect(md).toContain("## Today\n\n- 9:00 AM stand-up");
  });
  it("draws Read it to me only where the web view has a voice, and stops it on leaving", () => {
    expect(briefSrc).toContain('"speechSynthesis" in window');
    expect(briefSrc).toContain("onDestroy(stopReading)");
  });
});

describe("watch", () => {
  it("a connector checked on its own says when", () => {
    const reach = { checked_at: null, error: null, locals: [], accounts: [{ connector: "claude.ai Gmail", service: "Gmail", kind: "mail" as const, address: null, nth: null, status: "connected" as const, on: true, claude_ai: true, in_scan: true, checked_at: "2026-11-19T09:05:00Z" }] };
    const rows = sourceRows(reach, [], (a) => a.service, (s) => s, () => "9:05 AM");
    expect(rows[0].detail).toContainEqual(["Checked", "9:05 AM, on its own"]);
  });
  it("each source row has its own Check now", () => {
    expect(watchSrc).toContain("checkSource(s.id)");
    expect(watchSrc).toContain("Check all");
  });
});

describe("stage", () => {
  it("draws every task view", () => {
    expect(stageSrc).toContain('const TASK_VIEWS = ["timeline", "todo", "triage", "browse", "run", "research"]');
    for (const v of ["Timeline", "Todo", "Triage", "Browse", "Run", "Research"]) expect(stageSrc).toContain(`<${v} task={t} />`); // batch 4: one snippet draws the view in focus and the split's second
    expect(stageSrc).toContain("{@render taskView(focusTask)}");
  });
});
