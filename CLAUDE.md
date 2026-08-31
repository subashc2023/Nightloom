# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

Everything below the import is an **index**, not content. This file is loaded
into every session, so it stays small; the reference behind it is read on demand.

@AGENTS.md

## Reference

`docs/` holds the long-form reference: every non-obvious decision in the codebase
with the argument that produced it. Read the file you need with `Read` — most of
what looks arbitrary in this codebase was measured, and the reason is in here
rather than in the code.

| file | what is in it |
|---|---|
| [docs/commands.md](docs/commands.md) | Every command, not just the common ones: the REPL and its flags, the Claude Code engine, keys, the vault, dreaming, importing, evals and probes, the desktop app, the manual smoke-test examples. |
| [docs/core.md](docs/core.md) | `nightloom-core`. The `Provider` trait and `StreamEvent`; `Tool` / `ToolDef` / `Effect`, result size and cancellation; reasoning and thinking replay; `SystemPrompt` layering; `Usage` normalization; the session log, its crash consistency and the markers (`Rewind`, `Elide`) that supersede without mutating; recorded cost and titles; images and documents; the context view; external agents. |
| [docs/providers.md](docs/providers.md) | `nightloom-providers`. The four wire dialects and how reasoning replay differs across them; the registry and `list_models`; `limits.rs` and `pricing.rs`; Anthropic's two cache breakpoints and what they measured. |
| [docs/service-engine.md](docs/service-engine.md) | `turn.rs` — the streaming tool loop, the invariants shells must not reimplement, serial consent with adjacent-read overlap, approval, model-initiated compaction, session titles. |
| [docs/service-prompt.md](docs/service-prompt.md) | `prompt.rs` and `sidecar.rs` — the static preamble, the `AGENTS.md` walk, the docspace and vault index layers and how the vault index survives scale; the per-turn sidecar and the compaction advisory. |
| [docs/service-tools.md](docs/service-tools.md) | The built-in tools: `Root` path confinement and the `@kb` alias, subagents, cross-model review and the reviewer bench, web fetch and the search chain, and why killing a shell is not killing the command. |
| [docs/service-data.md](docs/service-data.md) | Where things live. Projects (a project is not a folder), the knowledge vault, the memory inbox and the dream, credentials, the claude.ai importer, session-log discovery. |
| [docs/service-agent.md](docs/service-agent.md) | `agent/` — driving the signed-in `claude` CLI as a second engine behind the same event stream, and the four load-bearing details behind it. |
| [docs/mcp.md](docs/mcp.md) | `nightloom-mcp`. The two wires and where correlation lives, `McpTool`'s always-`Mutating` classification, Streamable HTTP, `mcp.json`. |
| [docs/evals.md](docs/evals.md) | `nightloom-evals`. The agentic suite and its traps, the three shape tasks, the probe. |
| [docs/cli.md](docs/cli.md) | `nightloom-cli`. The REPL and its commands, every flag, the subcommands, the `--agent claude-code` REPL. |
| [docs/desktop.md](docs/desktop.md) | The Tauri backend: commands and state, sessions, agent mode, tool approval, projects, MCP and reviewer wiring, rewind / context / cost, the importer. |
| [docs/desktop-ui.md](docs/desktop-ui.md) | The Svelte frontend: the types seam, the custom window frame and why macOS is exempt, the rail, settings and the model picker, notes and the vault graph, the composer, math rendering. |
| [docs/conventions.md](docs/conventions.md) | The long form of `AGENTS.md`'s rules, plus the findings behind them: what a prompt change is measured to buy, the search-scope bugs, the two extensions to the effect rule, tests and CI. |

`.agents/dreaming.md` is a design document rather than reference — the research
and the model bench behind the memory system.
