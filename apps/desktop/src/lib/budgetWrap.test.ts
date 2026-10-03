import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnBudget } from "./types";

// *Wrap up* at the usage line (nightshift backlog 192): the flow against a
// stand-in for the app's state and the backend.
const calls: string[] = [];
const fake = vi.hoisted(() => ({
  app: {
    busy: false,
    budgetSession: null as string | null,
    activeSessionId: null as string | null,
    connection: { engine: "claude-code" } as { engine: string } | null,
    turnBudget: null as TurnBudget | null,
  },
  delivered: false,
}));
vi.mock("./state.svelte", () => ({
  app: fake.app,
  addToast: (t: string) => calls.push(`toast ${t}`),
  readTurnBudget: async (s: string) => {
    calls.push(`read ${s}`);
    fake.app.turnBudget = { wrap_at_ms: fake.delivered ? 9 : null } as TurnBudget;
  },
  send: async (text: string) => {
    calls.push(`send ${text.slice(0, 20)}`);
  },
}));
vi.mock("./api", () => ({
  budgetOverride: async (s: string, d: string, text?: string) => {
    calls.push(`answer ${s} ${d} ${text ? text.slice(0, 20) : ""}`);
  },
}));
import { afterWrapTurn, wrapAsk, wrapTarget, wrapUp } from "./budgetWrap.svelte";

beforeEach(() => {
  calls.length = 0;
  Object.assign(fake.app, { busy: false, budgetSession: null, activeSessionId: null, turnBudget: null });
  fake.delivered = false;
  wrapAsk.session = null;
});

describe("Wrap up at the usage line", () => {
  it("answers the running chat's hook while its turn runs, parked or not", async () => {
    Object.assign(fake.app, { busy: true, budgetSession: "run", activeSessionId: "other" });
    expect(wrapTarget()).toBe("run");
    await wrapUp("run");
    expect(calls).toEqual(["answer run wrap The 5-hour usage win", "read run"]);
    expect(wrapAsk.session).toBe("run");
  });

  it("sends the wrap-up as the next message when no call carried it", async () => {
    Object.assign(fake.app, { busy: true, budgetSession: "run", activeSessionId: "run" });
    await wrapUp("run");
    fake.app.busy = false;
    calls.length = 0;
    await afterWrapTurn();
    expect(calls).toEqual(["read run", "send The 5-hour usage win"]);
    expect(wrapAsk.session).toBeNull();
  });

  it("sends nothing more when a call carried it", async () => {
    Object.assign(fake.app, { busy: true, budgetSession: "run", activeSessionId: "run" });
    await wrapUp("run");
    fake.app.busy = false;
    fake.delivered = true;
    calls.length = 0;
    await afterWrapTurn();
    expect(calls).toEqual(["read run"]);
  });

  it("with nothing running, the open chat gets it as a message", async () => {
    Object.assign(fake.app, { activeSessionId: "c1" });
    expect(wrapTarget()).toBe("c1");
    await wrapUp("c1");
    expect(calls).toEqual(["send The 5-hour usage win"]);
    fake.app.connection = null;
    expect(wrapTarget()).toBeNull();
    fake.app.connection = { engine: "claude-code" };
  });
});
