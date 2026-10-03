import { describe, expect, it } from "vitest";
import { connectorLabel, connectorNames, setConnectorAllowed } from "./connectors";
import { defaultDraft } from "./catalog";
import type { AgentInit } from "./types";

/** Backlog 235: the rail's connector switch and its per-connector ticks. */
const init = (names: string[]): AgentInit => ({
  session_id: null,
  model: null,
  version: null,
  permission_mode: null,
  tools: [],
  mcp_servers: names.map((name) => ({ name, status: "connected" })),
  slash_commands: [],
  skills: [],
  agents: [],
});

describe("claude.ai connectors (backlog 235)", () => {
  it("are off in a fresh draft", () => {
    const d = defaultDraft();
    expect(d.agentClaudeAi).toBe(false);
    expect(d.agentClaudeAiBlocked).toEqual([]);
  });

  it("lists only connectors, from the init event and the blocked list", () => {
    const names = connectorNames(init(["openalex", "claude.ai Google Drive", "claude.ai Claude Docs"]), [
      "claude.ai Gmail",
      "openalex",
    ]);
    expect(names).toEqual(["claude.ai Claude Docs", "claude.ai Gmail", "claude.ai Google Drive"]);
    expect(connectorNames(null, [])).toEqual([]);
  });

  it("unticking blocks one and ticking lets it back", () => {
    const blocked = setConnectorAllowed([], "claude.ai Google Drive", false);
    expect(blocked).toEqual(["claude.ai Google Drive"]);
    expect(setConnectorAllowed(blocked, "claude.ai Google Drive", false)).toEqual(["claude.ai Google Drive"]);
    expect(setConnectorAllowed(blocked, "claude.ai Google Drive", true)).toEqual([]);
  });

  it("labels drop the prefix", () => {
    expect(connectorLabel("claude.ai Google Drive")).toBe("Google Drive");
  });
});
