// Item 845, batch 5 (846 §2, blocker 2143): the four controls that start a short Home turn — the line goes into
// Home's chat once, or, when it cannot, is kept for Home's next look; never both, never neither. The phone's host
// sends it into Home's chat, and keeps the click when the Mac does not answer.
import { beforeAll, describe, expect, it } from "vitest";
import { setStageHost, stageHost, type StageHost } from "./host";
import { nudge, NUDGE_PREFIX } from "./tasks.svelte";
import { phoneStageHost } from "../../remote/phoneStageHost";

const task = { name: "Working your list", view: "todo" };

function host(over: Partial<StageHost>, told: string[]): StageHost {
  return { ...stageHost.now, taskEvent: async (_t: string, _v: string, line: string) => void told.push(line), ...over };
}

describe("the short turn", () => {
  it("goes into Home's chat with the prefix, and is not also kept", () => {
    const told: string[] = [];
    const sent: string[] = [];
    setStageHost(host({ nudge: (text) => void sent.push(text) }, told));
    nudge(task, "you took “Call Sam” back — leave it to you");
    expect(sent).toEqual([`${NUDGE_PREFIX}you took “Call Sam” back — leave it to you`]);
    expect(told).toEqual([]);
  });
  it("kept for the next look when it cannot go — once, even if the refusal comes twice", () => {
    const told: string[] = [];
    setStageHost(host({ nudge: (_t, fallback) => (fallback(), fallback()) }, told));
    nudge(task, "you handed “Book the car” to Home to do");
    expect(told).toEqual(["you handed “Book the car” to Home to do"]);
  });
  it("kept when the host throws", () => {
    const told: string[] = [];
    setStageHost(host({ nudge: () => { throw new Error("x"); } }, told));
    nudge(task, "you asked to stop");
    expect(told).toEqual(["you asked to stop"]);
  });
  const fsP = import(/* @vite-ignore */ "node:" + "fs") as Promise<{ readFileSync(u: URL, enc: string): string }>;
  let fs: { readFileSync(u: URL, enc: string): string };
  beforeAll(async () => void (fs = await fsP));
  it("the prefix is the Rust one", () => {
    const rs = fs.readFileSync(new URL("../../../../../crates/nightloom-service/src/home/tasks.rs", import.meta.url), "utf8");
    expect(rs).toContain(`pub const NUDGE_PREFIX: &str = "${NUDGE_PREFIX}";`);
  });
});

describe("the phone's short turn", () => {
  it("sends into Home's chat; with no chat or no answer the click is kept", async () => {
    const sends: [string | null, string][] = [];
    let fail = false;
    const client = {
      send: async (chat: string | null, text: string) => {
        if (fail) throw new Error("down");
        sends.push([chat, text]);
        return "sent" as const;
      },
    };
    const notes: string[] = [];
    let home = { project: "p1", chat: "c1" as string | null };
    const h = phoneStageHost({ client: () => client as never, home: () => home, scan: () => null, open: () => {}, note: (t) => void notes.push(t) });
    let kept = 0;
    h.nudge("x", () => void kept++);
    await new Promise((r) => setTimeout(r, 0));
    expect(sends).toEqual([["c1", "x"]]);
    expect(kept).toBe(0);
    fail = true;
    h.nudge("y", () => void kept++);
    await new Promise((r) => setTimeout(r, 0));
    expect(kept).toBe(1);
    home = { project: "p1", chat: null };
    h.nudge("z", () => void kept++);
    expect(kept).toBe(2);
  });
});

describe("Home's gated writes (846 §5 #3)", () => {
  const fsP = import(/* @vite-ignore */ "node:" + "fs") as Promise<{ readFileSync(u: URL, enc: string): string }>;
  let fs: { readFileSync(u: URL, enc: string): string };
  beforeAll(async () => void (fs = await fsP));
  it("the Mac's card offers Allow once and Deny, never a standing allow", () => {
    const src = fs.readFileSync(new URL("../ApprovalPrompt.svelte", import.meta.url), "utf8");
    expect(src).toContain('data-card-kind="home_write"');
    expect(src).toContain('req.kind === "connector" || req.kind === "home_write" ? "Allow once"');
    // "Allow always" is the connector card's alone; "Allow for this chat" is kept off this one.
    expect(src).toMatch(/\{#if req\.kind === "connector"\}\s*<button[^>]*data-act="always"/);
    expect(src).toContain('req.kind !== "remember" && req.kind !== "home_write"}');
    // Item 872: the same card asks for a Reminders change, and says so.
    expect(src).toContain("Home changes your mail, calendar or reminders only on your tap");
  });
  it("the phone's card offers Allow once and Deny only", () => {
    const src = fs.readFileSync(new URL("../../remote/Remote.svelte", import.meta.url), "utf8");
    const i = src.indexOf('{:else if req.kind === "home_write"}\n                <button');
    expect(i).toBeGreaterThan(0);
    const branch = src.slice(i, src.indexOf("{:else", i + 10));
    expect(branch).toContain("Allow once");
    expect(branch).toContain('answer(req, "deny")');
    expect(branch).not.toContain("always");
    expect(src).toContain("Home changes your mail, calendar or reminders only on your tap");
  });
});
