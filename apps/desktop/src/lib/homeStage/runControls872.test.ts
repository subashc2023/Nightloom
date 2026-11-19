// Item 872: Run's controls. Stop now stops the routed chat first and tells Home only once it stopped (a short turn);
// a stop that did not land says so and tells Home nothing. Resume and Run this step again are short turns.
import { afterEach, describe, expect, it } from "vitest";
import { setStageHost, stageHost, type StageHost } from "./host";
import { NUDGE_PREFIX } from "./tasks.svelte";
import { stopThenTell, resumeLine, againLine, stopNowLine } from "./runControls";

const task = { name: "Merge round T", view: "run" };
const base = stageHost.now;
afterEach(() => setStageHost(base));

function host(over: Partial<StageHost>, sent: string[], toasts: string[]): StageHost {
  return { ...base, routedRunning: async () => ["c1"], nudge: (t) => void sent.push(t), toast: (t) => void toasts.push(t), ...over };
}

describe("Stop now", () => {
  it("stops the chat, then tells Home once", async () => {
    const sent: string[] = [];
    const stopped: string[] = [];
    setStageHost(host({ stopChat: async (c) => void stopped.push(c) }, sent, []));
    expect(await stopThenTell(task, "c1", "Checks")).toBe(true);
    expect(stopped).toEqual(["c1"]);
    expect(sent).toEqual([NUDGE_PREFIX + stopNowLine("Checks")]);
    expect(sent[0]).toContain('in the middle of "Checks"');
  });
  it("a stop that did not land tells Home nothing and says so", async () => {
    const sent: string[] = [];
    const toasts: string[] = [];
    setStageHost(host({ stopChat: async () => { throw new Error("the desktop window could not take the stop"); } }, sent, toasts));
    expect(await stopThenTell(task, "c1", null)).toBe(false);
    expect(sent).toEqual([]);
    expect(toasts).toEqual(["The chat was not stopped — the desktop window could not take the stop"]);
  });
  it("a chat no route of Home's is running is never stopped (his own chat, another chat, one that ended)", async () => {
    const sent: string[] = [];
    const toasts: string[] = [];
    const stopped: string[] = [];
    setStageHost(host({ stopChat: async (c) => void stopped.push(c) }, sent, toasts));
    expect(await stopThenTell(task, "his-main-chat", null)).toBe(false);
    expect(stopped).toEqual([]);
    expect(sent).toEqual([]);
    expect(toasts[0]).toContain("not a chat Home routed that is running now");
  });
  it("when the routes cannot be read, nothing is stopped or told", async () => {
    const sent: string[] = [];
    const stopped: string[] = [];
    setStageHost(host({ routedRunning: async () => { throw new Error("the Mac is not answering"); }, stopChat: async (c) => void stopped.push(c) }, sent, []));
    expect(await stopThenTell(task, "c1", null)).toBe(false);
    expect(stopped).toEqual([]);
    expect(sent).toEqual([]);
  });
  it("with no host that can stop chats, nothing is told", async () => {
    const sent: string[] = [];
    setStageHost(host({ stopChat: base.stopChat }, sent, []));
    expect(await stopThenTell(task, "c1", null)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("the words", () => {
  it("say which stop was resumed and which step to run again", () => {
    expect(resumeLine(true)).toContain("its chat was stopped");
    expect(resumeLine(false)).toContain("stop after the step in hand");
    expect(againLine("Build", true)).toBe('you asked to run step "Build" again (it had failed) — send it into the chat running this');
    expect(againLine("Build", false)).not.toContain("failed");
  });
});
