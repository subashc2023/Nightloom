// Item 898 (847 phase 2, F2): a page Home writes with update_task (view "brief", data {title, body}) is drawn on the
// stage by the Brief view, on the Mac and on the phone; the morning scan's own Brief tab is unchanged.
import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { Component } from "svelte";
import Brief from "./views/Brief.svelte";
import stageSrc from "./Stage.svelte?raw";
import phoneStageSrc from "../../remote/HomeStage.svelte?raw";
import type { HomeTask } from "./host";
import { briefPageOf } from "./taskData";

const task = (data: unknown, over: Partial<HomeTask> = {}): HomeTask => ({
  id: "what-to-prepare-before-denver",
  view: "brief",
  name: "What to prepare before Denver",
  doing: "",
  step: 0,
  of: 0,
  state: "live",
  needs: 0,
  why: "",
  data,
  started_at: "2026-11-23T03:00:00Z",
  updated_at: "2026-11-23T03:01:00Z",
  ...over,
});
const draw = (t?: HomeTask) => render(Brief as unknown as Component<{ task?: HomeTask }>, { props: t ? { task: t } : {} }).body;
const text = (html: string) => html.replace(/<!--[^]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// The model's own data from the 847 p2 run s10 (shortened).
const s10 = { title: "What to prepare before Denver", body: "**Flight:** Thu Nov 26, 7:10 AM from SEA\n**Hotel:** The Maven, Denver\n\n## Still to do\n- [ ] **Polish slides.** Finish by Wed night.\n- [ ] **Print boarding pass.**\n\n## Before you leave\n- Slides in two places" };

describe("898: a brief task", () => {
  it("reads {title, body}, keeping the body's lines; text or page stand in for body; junk reads empty", () => {
    const p = briefPageOf(s10);
    expect(p.title).toBe("What to prepare before Denver");
    expect(p.body.split("\n").length).toBeGreaterThan(5);
    expect(briefPageOf({ text: "a\nb" }).body).toBe("a\nb");
    expect(briefPageOf({ page: "x" }).body).toBe("x");
    for (const junk of [null, 3, "x", [], { body: 4 }]) expect(briefPageOf(junk)).toEqual({ title: "", body: "" });
    expect(briefPageOf({ body: "y".repeat(30_000) }).body.length).toBe(20_000);
  });

  it("is drawn by the Brief view: its title, its sections, no scan wording", () => {
    const t = text(draw(task(s10)));
    expect(t).toContain("What to prepare before Denver");
    expect(t).toContain("Still to do");
    expect(t).toContain("Before you leave");
    expect(t).not.toContain("No scan in this chat yet");
    expect(t).not.toContain("Today's page");
  });

  it("with no body yet: Home's doing line while live, a plain line when done", () => {
    expect(text(draw(task({ title: "T" }, { doing: "Writing the Denver page" })))).toContain("Writing the Denver page");
    expect(text(draw(task({}, { state: "done" })))).toContain("Home has not written this page yet");
  });

  it("the scan's own Brief is unchanged without a task", () => {
    expect(text(draw())).toContain("Today's page");
  });

  it("both stages list brief tasks and draw them with the Brief view", () => {
    for (const src of [stageSrc, phoneStageSrc]) {
      expect(src).toContain('const TASK_VIEWS = ["timeline", "todo", "triage", "browse", "run", "research", "brief"]');
      expect(src).toContain("<Brief task=");
      expect(src).toMatch(/focus\.view === "brief" && !focusTask/);
    }
  });
});
