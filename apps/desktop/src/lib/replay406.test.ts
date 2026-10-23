import { describe, expect, it } from "vitest";
import type { SubagentRow } from "./state.svelte";
import { latestAgents } from "./subagentRows";
import steps from "./__fixtures__/406-replay.json";

/**
 * Backlog 406's replay harness, the window's half. The fixture is what the
 * real translator and inbox emitted for his chat's 08:15–08:23Z sequence
 * (2026-10-23) and a SendMessage resume after it — the Rust test
 * `agent::inbox::tests::wake::a_lone_notification_after_a_relayed_handback_wakes_the_chat_once`
 * writes it with `NIGHTLOOM_406_DUMP=<path>`. Each status is applied the
 * way `upsertSubagentRow` applies it (replace by `tool_use_id`), and the
 * chip's words are TopBar's: `N agents · K running`, or `· done`.
 */
type Step = { label: string; statuses: Record<string, unknown>[]; still_running: string[]; woke: { type: string; text: string; agents: string[] } | null };

function chip(rows: SubagentRow[]): string {
  const a = latestAgents(rows, "c");
  if (a.rows.length === 0) return "";
  return `${a.rows.length} agent${a.rows.length === 1 ? "" : "s"} · ${a.running === 0 ? "done" : `${a.running} running`}`;
}

function replay(): { label: string; chip: string; still: string[]; woke: boolean }[] {
  const rows: SubagentRow[] = [];
  return (steps as Step[]).map((s) => {
    for (const st of s.statuses) {
      const { type: _t, ...status } = st as { type: string } & Record<string, unknown>;
      const row = rows.find((r) => r.tool_use_id === status.tool_use_id);
      if (row) Object.assign(row, status);
      else rows.push({ ...(status as unknown as SubagentRow), session: "c", turn: 1, startedAt: 0, updatedAt: 0, segments: [] });
    }
    return { label: s.label, chip: chip(rows), still: s.still_running, woke: s.woke !== null };
  });
}

describe("406: his chat's sequence through the window's rows", () => {
  it("shows each agent running until its end, then wakes the chat exactly once", () => {
    const out = replay();
    const at = (label: string) => out.find((o) => o.label === label)!.chip;
    expect(at("started market")).toBe("3 agents · 3 running");
    expect(at("market notified")).toBe("3 agents · 2 running");
    expect(at("bench notified")).toBe("3 agents · 1 running");
    expect(at("HF notified (lone)")).toBe("3 agents · done");
    // The bottom notice at the first reply's end names all three.
    expect(out.find((o) => o.label === "result")!.still).toHaveLength(3);
    const wakes = out.filter((o) => o.woke);
    expect(wakes).toHaveLength(1);
    const w = (steps as Step[]).find((s) => s.woke)!.woke!;
    expect(w.type).toBe("woke");
    expect(w.agents).toEqual(["Hugging Face incident facts"]);
    expect(w.text.startsWith("[Nightloom, not from Swaraag:")).toBe(true);
  });

  it("a finished agent resumed by SendMessage runs again on its own row, then is done", () => {
    const out = replay();
    const at = (label: string) => out.find((o) => o.label === label)!;
    expect(at("bench resumed").chip).toBe("3 agents · 1 running");
    // The reply's end while it runs: the bottom notice names it.
    const resumeEnd = out.slice(out.findIndex((o) => o.label === "bench resumed")).find((o) => o.label === "result")!;
    expect(resumeEnd.still).toEqual(["Benchmark suite feasibility"]);
    expect(at("bench notified (resume)").chip).toBe("3 agents · done");
    // Still three rows: the SendMessage call is not one.
    expect(out[out.length - 1].chip.startsWith("3 agents")).toBe(true);
  });

  it("prints the chip after each line, for the report", () => {
    const lines = replay().map((o, i) => `${String(i).padStart(2)} ${o.label.padEnd(26)} ${o.chip}${o.still.length ? `  [still running: ${o.still.length}]` : ""}${o.woke ? "  [WAKE]" : ""}`);
    console.log(lines.join("\n"));
    expect(lines.length).toBeGreaterThan(40);
  });
});
