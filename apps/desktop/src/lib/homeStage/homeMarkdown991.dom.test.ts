// @vitest-environment happy-dom
/*
 * Item 991 (his bug, 2026-11-25 3:00 PM): Home's reply box showed the model's markdown raw — `**Google Drive:**`,
 * "- " bullets — and an <ask> block as loose text with no way to answer. Every surface of the family is drawn here
 * and read back from the DOM (item 980's rule: render, not source text):
 *  - the Home stage's reply strip: markdown drawn, an <ask> its question box plus the chat's own question card;
 *  - a brief's section (block markdown), a Home row's one line (inline markdown, formulas still typeset), Detail rows;
 *  - the phone's renderer draws an <ask> block as the question box;
 *  - a skip written by an older build says so; the Sources rows say where their access comes from (990).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The question card's click goes to answerAsk (needsBoard) — captured here; everything else is the real module.
const answered: { answer: string; question: string }[] = [];
vi.mock("../needsBoard.svelte", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, answerAsk: async (_t: unknown, ask: { question: string }, answer: string) => (answered.push({ answer, question: ask.question }), true) };
});
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
// asides.svelte.ts first: it and state.svelte import each other, and its save effect reads `app` — loaded the other
// way round, the effect ran before state.svelte had finished (an unhandled "reading 'activeSessionId'").
import "../asides.svelte";
import { app } from "../state.svelte";
import InlineMd from "../InlineMd.svelte";
import Detail from "./Detail.svelte";
import Brief from "./views/Brief.svelte";
import Stage from "./Stage.svelte";
import { stage } from "./stageState.svelte";
import { renderMarkdown, renderInline } from "../markdown";
import { skipWhy } from "../skipWhy";
import { lastText, confirmAsk, type Job } from "../../remote/jobs";
import { sourceRows } from "./watch";
import { reachName, reachNote, reachStatusWords, skippedScanToday, type HomeReach } from "../home";
import type { HomeTask } from "./host";

const SCAN_REPLY = `None of them is a direct personal email. These three are the closest to needing you:
- **Google Drive:** someone shared a document called "UCI Course Plan" with you.
- **Tally:** an "Application form response" came in.

<ask>
Should I read the three in full now?
- Yes, read them now
- No, leave it for the next scan
</ask>`;

let root: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (root) unmount(root);
  root = null;
  document.body.innerHTML = "";
});

describe("a Home row's one line (InlineMd)", () => {
  it("draws bold, code and a link, and keeps a formula typeset", () => {
    root = mount(InlineMd, { target: document.body, props: { text: "**Google Drive:** shared `plan.pdf` — see [it](https://example.com) and $\\frac{a}{b}$" } });
    flushSync();
    const el = document.body.querySelector(".md-inline")!;
    expect(el.querySelector("strong")?.textContent).toBe("Google Drive:");
    expect(el.querySelector("code")?.textContent).toBe("plan.pdf");
    expect(el.querySelector("a")?.textContent).toBe("it");
    expect(el.querySelector(".katex")).not.toBeNull();
    expect(el.textContent).not.toContain("**");
    expect(el.querySelector("p")).toBeNull();
  });
  it("leaves dollar amounts as prose", () => {
    expect(renderInline("It costs $5 and $6 a month")).not.toContain("katex");
  });
});

describe("Detail rows", () => {
  it("draws a value's markdown", () => {
    root = mount(Detail, { target: document.body, props: { rows: [["What", "**Tally:** a form response"]] } });
    flushSync();
    expect(document.body.querySelector("dd strong")?.textContent).toBe("Tally:");
  });
});

describe("a brief's section", () => {
  it("draws its list and bold, not the marks", () => {
    const task = { id: "b1", view: "brief", name: "Brief", doing: "", step: 0, of: 0, state: "done", needs: 0, why: "", data: { title: "Today", body: "## Mail\n- **Google Drive:** a shared plan\n- **Luma:** approved" }, started_at: "", updated_at: "" } as HomeTask;
    root = mount(Brief, { target: document.body, props: { task } });
    flushSync();
    // Open the section if it is folded.
    if (!document.body.querySelector(".b-body")) (document.body.querySelector(".b-sec") as HTMLElement | null)?.click();
    flushSync();
    const body = document.body.querySelector(".b-body")!;
    expect(body).not.toBeNull();
    expect(body.querySelectorAll("li")).toHaveLength(2);
    expect(body.querySelector("strong")?.textContent).toBe("Google Drive:");
    expect(body.textContent).not.toContain("**");
  });
});

describe("the stage's reply strip", () => {
  it("draws Home's reply as markdown with its <ask> as a question box and the clickable question card", () => {
    app.view = "chat";
    app.activeSessionId = "home-chat";
    app.events = [
      { event: "user_message", text: "anything in my mail?", at: "2026-11-25T23:00:00Z" },
      { event: "assistant_message", blocks: [{ type: "text", text: SCAN_REPLY }], at: "2026-11-25T23:00:10Z" },
    ] as never;
    stage.focus = "watch";
    stage.strip = "open";
    const children = createRawSnippet(() => ({ render: () => "<div></div>" }));
    root = mount(Stage, { target: document.body, props: { blank: false, children } });
    flushSync();
    const said = document.body.querySelector(".h9-said-tx")!;
    expect(said).not.toBeNull();
    expect(said.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
    expect(said.querySelector("strong")?.textContent).toBe("Google Drive:");
    expect(said.textContent).not.toContain("**");
    expect(said.textContent).not.toContain("<ask>");
    // The <ask> block: the quiet "Question for you" box in the reply…
    expect(said.querySelector(".nl-ask .nl-ask-q")?.textContent).toBe("Should I read the three in full now?");
    // …and the chat's own question card under it, its answers as buttons.
    const card = document.body.querySelector(".h9-said-ask")!;
    expect(card).not.toBeNull();
    const opts = [...card.querySelectorAll(".aq-opt")] as HTMLElement[];
    const names = opts.map((o) => o.querySelector(".aq-ol")?.textContent?.trim());
    expect(names.slice(0, 2)).toEqual(["Yes, read them now", "No, leave it for the next scan"]);
    // A click on an answer sends it (as the chat's card does).
    opts[0].click();
    flushSync();
    expect(answered).toEqual([{ answer: "Yes, read them now", question: "Should I read the three in full now?" }]);
  });
  it("draws no question card once he has answered", () => {
    app.view = "chat";
    app.activeSessionId = "home-chat";
    app.events = [
      { event: "user_message", text: "anything in my mail?", at: "2026-11-25T23:00:00Z" },
      { event: "assistant_message", blocks: [{ type: "text", text: SCAN_REPLY }], at: "2026-11-25T23:00:10Z" },
      { event: "user_message", text: "Yes, read them now", at: "2026-11-25T23:01:00Z" },
      { event: "assistant_message", blocks: [{ type: "text", text: "Read them — **nothing** urgent." }], at: "2026-11-25T23:01:30Z" },
    ] as never;
    stage.focus = "watch";
    stage.strip = "open";
    const children = createRawSnippet(() => ({ render: () => "<div></div>" }));
    root = mount(Stage, { target: document.body, props: { blank: false, children } });
    flushSync();
    expect(document.body.querySelector(".h9-said-ask")).toBeNull();
    expect(document.body.querySelector(".h9-said-tx strong")?.textContent).toBe("nothing");
  });
});

describe("the phone's renderer", () => {
  it("draws an <ask> block as the question box", () => {
    const html = renderMarkdown(SCAN_REPLY, { breaks: true, localImagesAsText: true });
    const div = document.createElement("div");
    div.innerHTML = html;
    expect(div.querySelector(".nl-ask .nl-ask-q")?.textContent).toBe("Should I read the three in full now?");
    expect(div.querySelectorAll(".nl-ask-o li")).toHaveLength(2);
    expect(div.querySelector("strong")?.textContent).toBe("Google Drive:");
  });
});

describe("a skip an older build wrote (950/953 wording)", () => {
  const old = "at this pace the weekly window runs out before it resets";
  it("says it was an older build's rule, on the row, the card and the brief", () => {
    expect(skipWhy(old)).toBe("by an older build's rule: the weekly pace looked too fast (the pace alone no longer skips a run)");
    // A figure the older build wrote ("the weekly window is at 91%") stays as written: it was true when written.
    expect(skipWhy("the weekly window is at 91%")).toBe("the weekly window is at 91%");
    const fresh = "the weekly window was at 91% at 7:55 AM (a /usage run)";
    expect(skipWhy(fresh)).toBe(fresh);
    const now = new Date("2026-11-25T23:00:00Z");
    const job = { id: "home-morning-scan", title: "Home — Morning scan", last: { started: "2026-11-25T16:00:00Z", ended: "2026-11-25T16:00:00Z", outcome: "skipped", summary: `skipped — ${old}` }, confirm: { scheduled: true, at: "2026-11-25T16:00:00Z", why: old, five_hour: 10, week: 70, est_week: 1, est_five: 2, stale: false } } as unknown as Job;
    const line = lastText(job, now);
    expect(line).not.toContain("runs out before it resets");
    expect(line).toContain("older build's rule");
    expect(confirmAsk(job, now)!.reason).toContain("older build's rule");
    const rows = [{ at: "2026-11-25T16:00:00Z", kind: "scan", line: `Morning scan skipped — ${old}`, label: null, chat: null, project: null }];
    expect(skippedScanToday(rows as never, new Date("2026-11-25T20:00:00Z"))!.why).toContain("older build's rule");
  });
});

describe("Sources say where their access comes from (990)", () => {
  const reach: HomeReach = {
    checked_at: "2026-11-25T23:00:00Z",
    error: null,
    locals: [],
    accounts: [1, 2, 3].map((n) => ({ connector: `claude.ai Gmail ${n}`, service: "Gmail", kind: "mail", address: null, nth: n, status: "connected", on: true, claude_ai: true, in_scan: true })),
  };
  it("names the Claude account's connectors, and says the address is not known yet", () => {
    const rows = sourceRows(reach, [], reachName, reachStatusWords);
    expect(rows[0].via).toBe("through your Claude account's connectors");
    expect(rows[0].why).toContain("Via your Claude account's connector");
    const access = rows[0].detail.find(([k]) => k === "Access")![1];
    expect(access).toContain("claude.ai connector on your Claude account");
    expect(access).toContain("Nightloom holds no Gmail sign-in");
    expect(rows[0].detail.find(([k]) => k === "Account")![1]).toContain("Not named yet");
    expect(reachNote(reach.accounts[0])).toContain("Claude account's connector");
  });
  it("shows a not-signed-in connector as needing sign-in, not green", () => {
    const r = { ...reach, accounts: [{ ...reach.accounts[0], status: "needs_sign_in" as const }] };
    const [row] = sourceRows(r, [], reachName, reachStatusWords);
    expect(row.light).toBe("warn");
    expect(row.state).not.toContain("connected");
  });
});
