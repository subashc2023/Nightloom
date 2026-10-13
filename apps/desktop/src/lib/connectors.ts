/**
 * His claude.ai connectors on the Claude Code engine (nightshift backlog
 * 235, blocker 490). Off by default: the CLI loads none. On, the rail lists
 * the ones the last init event named, each with a tick; an unticked one is
 * sent as blocked and becomes a server-level `--disallowedTools` rule
 * (`crates/nightloom-service/src/agent/connectors.rs`). A blocked
 * connector still appears in the init event (measured: the rule hides its
 * tools, not the server), so it stays listed to be ticked back.
 */
import type { AgentInit } from "./types";

/** The CLI's name for every connector: "claude.ai Google Drive". */
export const CONNECTOR_PREFIX = "claude.ai ";

/** The connectors to list: those the init event named, and any still
 *  blocked from before, once each, in name order. */
export function connectorNames(init: AgentInit | null, blocked: string[]): string[] {
  const seen = new Set<string>();
  for (const s of init?.mcp_servers ?? []) {
    if (s.name.startsWith(CONNECTOR_PREFIX)) seen.add(s.name);
  }
  for (const b of blocked) {
    if (b.startsWith(CONNECTOR_PREFIX)) seen.add(b);
  }
  return [...seen].sort();
}

/** The blocked list after ticking (`allowed` true) or unticking one. */
export function setConnectorAllowed(blocked: string[], name: string, allowed: boolean): string[] {
  const rest = blocked.filter((b) => b !== name);
  return allowed ? rest : [...rest, name].sort();
}

/** "claude.ai Google Drive" → "Google Drive", for the rail's label. */
export function connectorLabel(name: string): string {
  return name.startsWith(CONNECTOR_PREFIX) ? name.slice(CONNECTOR_PREFIX.length) : name;
}
