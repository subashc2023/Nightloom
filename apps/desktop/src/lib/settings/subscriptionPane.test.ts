// Settings → Subscription grouped and searchable (nightshift backlog 546).
// "Nothing removed or renamed; every setting still works": the suite runs
// in node, so each control's binding is checked in the pane's source — the
// same aria-label, the same handler, inside the right group — and the
// filter and summaries are checked as the pure functions they are.
import { describe, expect, it } from "vitest";
import modalSrc from "../SettingsModal.svelte?raw";
import {
  CONTROLS,
  GROUPS,
  controlMatches,
  handoffSummary,
  matchCount,
  matchingControls,
  modelsSummary,
  subagentsSummary,
  updatesSummary,
} from "./subscriptionPane";

const pane = (() => {
  const a = modalSrc.indexOf('{:else if selected === "claude-code"}');
  const b = modalSrc.indexOf("{:else if selected === USAGE_PANE", a);
  return modalSrc.slice(a, b);
})();

/** The source of one group, from its SettingsGroup tag to the next. */
function groupSrc(id: string): string {
  const a = pane.indexOf(`fold="subscription/${id}"`);
  const b = pane.indexOf("</SettingsGroup>", a);
  expect(a, `group ${id} is rendered`).toBeGreaterThan(-1);
  return pane.slice(a, b);
}

/** Every control the pane had at 9b78ee2, its binding, and its group. */
const BINDINGS: { group: string; marks: string[] }[] = [
  {
    group: "handoff",
    marks: [
      'aria-label="Hand-off threshold, percent of the context window, for every chat"',
      "setHandoffDefaultPct(",
      'aria-label="Hand-off token cap, thousands of tokens, for every chat without a mark of its own"',
      "setHandoffCapK(",
      'aria-label="Hand-off threshold, percent of the context window, for the open chat"',
      "setHandoffChatPct(",
      "onclick={clearHandoffChatPct}>Use the default</button>",
      'aria-label="The default wrap-up message"',
      "value={handoffDefaultMessage()}",
      "setHandoffDefaultMessage((e.currentTarget",
      'onclick={() => setHandoffDefaultMessage("")}>Reset to default</button>',
      'aria-label="The default read order a continued chat opens with"',
      "value={defaultReadOrder()}",
      "setDefaultReadOrder(",
      "onclick={clearDefaultReadOrder}>Reset to default</button>",
    ],
  },
  {
    group: "models",
    marks: [
      "{#each modelList.models as m, i (m)}",
      'aria-label="Move {m} up"',
      'aria-label="Move {m} down"',
      'aria-label="Remove {m}"',
      "onclick={() => setModelList([])}>Reset to built-in</button",
      'aria-label="A model to add"',
      "bind:value={newModelId}",
      "onclick={addModelId}",
      'aria-label="The away server\'s default model"',
      "setModelList(modelList.models, e.currentTarget.value || null)",
    ],
  },
  {
    group: "subagents",
    marks: ['aria-label="Default subagent rules"', "value={subagentRules.store.default}", "setDefaultRules("],
  },
  {
    group: "updates",
    marks: [
      "onclick={() => void checkCli(true)}",
      "<CliUpdateActions />",
      "checked={cli.prefs.auto}",
      "setAutoUpdate(e.currentTarget.checked)",
      "checked={app.layerPrefs.autoAtCold}",
      "setAutoLayers(e.currentTarget.checked)",
      "The last update's output",
    ],
  },
];

describe("the Subscription pane keeps every control (backlog 546)", () => {
  for (const { group, marks } of BINDINGS) {
    for (const m of marks) {
      it(`${group}: ${m}`, () => {
        expect(groupSrc(group)).toContain(m);
      });
    }
  }

  it("renders the groups in the inventory's order", () => {
    const at = GROUPS.map((g) => pane.indexOf(`fold="subscription/${g.id}"`));
    expect(at.every((x) => x > -1)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });

  it("gives every inventoried control a row in its own group", () => {
    for (const c of CONTROLS) {
      const src = groupSrc(c.group);
      expect(src, c.id).toContain(`fold="subscription/${c.id}" shown={subShown("${c.id}")}`);
    }
  });

  it("has no row the inventory does not know", () => {
    const rows = [...pane.matchAll(/<SettingRow fold="subscription\/([a-z-]+)"/g)].map((m) => m[1]);
    expect(rows.sort()).toEqual(CONTROLS.map((c) => c.id).sort());
  });

  it("has a filter box bound to the pane's filter", () => {
    expect(pane).toContain('aria-label="Find a Subscription setting"');
    expect(pane).toContain('setPaneFilter("subscription", e.currentTarget.value)');
  });
});

describe("the filter", () => {
  it("keeps everything when blank", () => {
    expect(matchCount("")).toBe(CONTROLS.length);
    expect(matchCount("   ")).toBe(CONTROLS.length);
  });

  it("finds the hand-off by the words he would type", () => {
    expect(matchingControls("handoff", "token cap").map((c) => c.id)).toEqual(["handoff-cap"]);
    expect(matchingControls("handoff", "WRAP-UP message").map((c) => c.id)).toContain("handoff-message");
    expect(matchingControls("models", "handoff")).toEqual([]);
  });

  it("matches a group's title to all its controls", () => {
    expect(matchingControls("models", "models").length).toBe(CONTROLS.filter((c) => c.group === "models").length);
  });

  it("needs every word to match", () => {
    const away = CONTROLS.find((c) => c.id === "models-away")!;
    expect(controlMatches(away, "away model")).toBe(true);
    expect(controlMatches(away, "away banana")).toBe(false);
  });

  it("finds update and memory settings", () => {
    expect(matchingControls("updates", "update").length).toBeGreaterThan(0);
    expect(matchingControls("updates", "claude.md").map((c) => c.id)).toEqual(["updates-layers"]);
  });
});

describe("the folded headers' summaries", () => {
  it("hand-off: default, cap, the chat's own mark, edits", () => {
    const base = { pct: 70, capK: 300, chatPct: null, chatOwn: false, messageEdited: false, readOrderEdited: false };
    expect(handoffSummary(base)).toBe("70% or 300k");
    expect(handoffSummary({ ...base, capK: 0 })).toBe("70%, no cap");
    expect(handoffSummary({ ...base, chatPct: 85, chatOwn: true })).toBe("70% or 300k · this chat 85%");
    expect(handoffSummary({ ...base, chatPct: 70, chatOwn: false })).toBe("70% or 300k");
    expect(handoffSummary({ ...base, messageEdited: true, readOrderEdited: true })).toBe("70% or 300k · message and read order edited");
  });

  it("models: the list, shortened past four, and the away default", () => {
    expect(modelsSummary(["fable", "opus", "sonnet", "haiku"], null)).toBe("fable, opus, sonnet, haiku · away: server's own");
    expect(modelsSummary(["a", "b", "c", "d", "e", "f"], "a")).toBe("a, b, c, d +2 · away: a");
  });

  it("subagents: none, or the start of his words", () => {
    expect(subagentsSummary("  ")).toBe("none set");
    expect(subagentsSummary("At most two.")).toBe("At most two.");
    expect(subagentsSummary("x".repeat(80)).length).toBe(48);
  });

  it("updates: version, behind, and both switches", () => {
    expect(updatesSummary({ installed: null, latest: null, behind: false, auto: false, layersAtCold: true })).toBe(
      "not checked · auto-update off · files at cold on",
    );
    expect(updatesSummary({ installed: "2.1.0", latest: "2.2.0", behind: true, auto: true, layersAtCold: false })).toBe(
      "2.1.0 → 2.2.0 · auto-update on · files at cold off",
    );
  });
});
