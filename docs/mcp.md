# nightloom-mcp

An MCP client: tools that live in another process, exposed as ordinary `Tool`s.
Its own crate on the same principle as `nightloom-providers` — a wire protocol
with its own framing, error taxonomy and lifecycle, which nothing downstream
should see the inside of.

`nightloom-service` re-exports it rather than wrapping it: a shell needs the
config type to discover servers and the report type to say which failed, and
nothing in between.

## `client.rs`

JSON-RPC 2.0 plus `initialize` / `tools/list` / `tools/call`, over either of two
wires.

The split is `Wire::Stream` vs `Wire::Http`, and what differs is **where
request/reply correlation lives**. A pipe is shared by every in-flight call, so
replies must be matched back by id and a reader task has to be running to do it.
HTTP correlates by construction — the answer arrives on its own request's
response — so there is no reader task and no pending table on that side, rather
than a stubbed one. `unwrap_reply` is shared, because "the server answered and
said no" versus "the connection broke" is the protocol's distinction and not the
pipe's.

`Client::from_streams` is what makes it testable without a server binary on the
machine: a test drives both ends of a `tokio::io::duplex` and scripts replies,
the same shape as the service's scripted providers.

Three failure modes are handled deliberately:

- a **request timeout** (60s) — a bound for the unattended case rather than a
  substitute for Ctrl-C. `tools/call` is the one request carrying the turn's
  `CancellationToken` (`initialize` and `tools/list` run at connect time, where
  there is no turn to interrupt), and cancellation is handled inside
  `StreamWire::request` rather than by racing it from outside, because the
  pending-reply entry outlives the future that registered it.
- an **EOF sweep** that fails every in-flight request when the stream ends, so a
  crashed server does not cost the full timeout.
- a **stderr tail**, kept because a server that dies during startup leaves no
  other explanation.

Pagination stops on a repeated cursor rather than spinning. The client declares
**no capabilities** — no sampling, no roots — since declaring one it does not
implement would invite requests it would have to refuse mid-turn.

## `tool.rs`

`McpTool` is **always `Effect::Mutating`**, and overrides the trait default
explicitly rather than inheriting it, so a reader does not have to wonder whether
it was an oversight. There is no honest classification available: a tool's name
and description are strings the server chose, and a server wanting past an
approval gate would only have to call its tool `read_something`.

Tool names are exposed as `server__tool`, sanitized to `[a-zA-Z0-9_-]{1,64}` — a
name outside that is a 400 on *every* request for the whole session, not a
failure of one tool. Prefixing also keeps a server's `read_file` from shadowing
the built-in one, whose workspace rooting and `ReadOnly` classification are not
the server's to inherit; the official filesystem server ships exactly such a
tool, so this is a live collision rather than a hypothetical.

A tool with no `inputSchema` still gets an empty object, since providers reject a
declaration without one. Content blocks flatten to text, naming what they cannot
carry (an image) rather than dropping it — an empty result reads as "the call did
nothing" and invites a retry loop.

## `http.rs` — Streamable HTTP

Spec revision `2025-06-18`. One POST per message, `Accept: application/json,
text/event-stream` because the server picks per response: a small result comes
back as JSON and one it wants to stream comes back as SSE. The SSE reader loops
rather than taking the first frame, since a server may put progress notifications
ahead of the reply.

Two pieces of server-kept state live here and nowhere else, being artifacts of
this transport:

- the `Mcp-Session-Id` a server may mint during `initialize` and expect back on
  everything after. A 404 while holding one is `SessionExpired`, and the id is
  *cleared*, so a dead session cannot turn into a run of confusing 404s.
- the `MCP-Protocol-Version` header, recorded from the handshake *before*
  `notifications/initialized` is sent, so even that first message carries it.

Verified against the official `@modelcontextprotocol/server-everything` in
`streamableHttp` mode: 13 tools listed, `get-sum` called, 42 returned.

Two things are deliberately absent: the **deprecated 2024-11-05 HTTP+SSE
transport** (`GET /sse` returning an `endpoint` event — a different handshake,
not a variation, and `"type": "sse"` gets an error naming that rather than
"unknown"), and the optional server-initiated `GET` stream, which exists to carry
requests *from* the server and this client declares no capabilities to receive.
The `DELETE` that would release a session on shutdown is also unsent: there is no
async shutdown hook to send it from.

## `config.rs`

`mcp.json` with the `mcpServers` key every other MCP host uses, which is worth
more than a name of our own — an existing config can be copied across unchanged,
and copying is how anyone gets a server running the first time.

Discovered from `~/.nightloom/` then the workspace's `.nightloom/`, project
winning on a name collision, mirroring how project instructions override user
memory in the preamble. A missing file is not an error.

`ServerSpec::transport()` decides stdio vs http — a `url` or a `command`, with
`"type"` needed only for the rare entry carrying both — and expands `${VAR}` on
the way. An **unset variable is an error, not an empty string**, and that is the
whole point of the feature: the alternative to writing `${GITHUB_TOKEN}` in a
config file is writing the token, which is how tokens end up in git, and silently
expanding a missing one sends `Authorization: Bearer ` and turns "you forgot to
export it" into a 401 from somebody else's server.

## Failure isolation

A server that fails to start costs one line and takes nothing else down:
`connect_all` returns a `ServerReport` per server. Failing a whole connection
because one of five servers is misconfigured would make MCP too brittle to leave
switched on.

## The server — `nightloom_service::mcp_server`

The mirror image, and it lives in the service crate rather than here because
what it serves is the service's tools: `search_chats`, `read_chat`, `remember`
and `fetch_page` (the API engine's `web_fetch` under a name that says what it
is for) — **and, since 2026-09-16, `context_status`** (nightshift backlog
073: the window's fill and the plan's usage, for the model to read; five
tools, ~~four~~). It exists for the Claude Code engine, which owns its own
loop and tool set and so cannot be handed a `Vec<Box<dyn Tool>>` the way
`Chat` is; passed to `claude -p` as `--mcp-config`, the ~~four~~ five reach
the model there as `mcp__nightloom__search_chats` and so on. The server is a
subcommand of both binaries — `nightloom mcp-serve [--project <id>]` and
`nightloom-desktop --mcp-serve [--project <id>]` — so the desktop can name
`current_exe()` in the config it hands over and never has to find a CLI that
is usually not on PATH. **Flags, corrected 2026-09-16** (the section above
was written for `--project` alone; `mcp_server::parse_args` is the
authority): `--no-remember` (2026-09-15; the four without `remember`, for a
chat whose memory switch is off), `--dream <json>` (below), and `--ask`
(2026-09-16, nightshift backlog 084: serves a sixth tool, `ask`, the Ask
position's permission-prompt tool, withheld from the model's own list —
[service-agent.md](service-agent.md) "The Ask position").

The wire is the one the client above speaks: newline-delimited JSON-RPC 2.0 on
stdio, `initialize` (capabilities `tools`, an `instructions` string saying which
tool to reach for), `tools/list` (each `ToolDef` as `name` / `description` /
`inputSchema`), `tools/call`, `ping`. The client's message types are not reused
because it has none — it works in `serde_json::Value`s, and so does this. Each
request is answered on its own task with one writer under a mutex, so a
`fetch_page` on a slow origin does not stall a `search_chats` beside it.

Two distinctions the client draws from its side are kept on this one. A tool
that **ran and failed** comes back as a result with `isError: true` and the
tool's message as its text, which the model reads and reacts to; a JSON-RPC
error is for a request the server could not serve at all — an unknown tool is
invalid params (`-32602`), an unknown method is method-not-found (`-32601`).
And a line that is not JSON costs a line on stderr, never the session, the same
rule the client's reader applies to a server.

**Which fetch, and the fallback (2026-09-17, nightshift backlog 125).** The
`initialize` instructions, the engine note (`prompt.rs`) and `fetch_page`'s own
description said "for a whole page use fetch_page, not WebFetch". On a site
that pre-renders for crawlers and serves a JavaScript shell to everyone else
(Obsidian's help site, measured), that sent the model to the fetch that got the
title where the CLI's `WebFetch` got the article, and the model spent two calls
deducing the switch. All three now say when each is the right one: `fetch_page`
for the whole text (`WebFetch` summarises and truncates); if `fetch_page`
reports a JavaScript shell or returns only a title, `WebFetch` on the same URL
instead of a retry. And the shell verdict itself, on this engine only, ends
with that sentence (`FetchPage::call` appends it to an error carrying
`tools::SHELL_PHRASE`): the inner tool cannot name `WebFetch`, because on the
API engine there is none.

`--project <id>` names the open project: its session directory is the default
search scope and its name is what `remember` stamps as `source`; without it,
the unfiled chats and no source. An id the registry does not know is an error
at startup rather than a fall-through — a server quietly searching the wrong
chats is the failure nobody would notice. The `ChatDirs` is built as the
desktop's `connect` builds it, every project's sessions plus the unfiled ones,
from the config dir the registry lives under (`capture::session_dirs`).

**A dream's server (2026-09-16, nightshift backlog 070).** Started with
`--dream <json>` — `nightloom mcp-serve --dream …`, `nightloom-desktop
--mcp-serve --dream …` — the server serves **one** tool, `propose_instructions`,
and none of the ~~four~~ five: the JSON (`mcp_server::DreamServe`: the store the
proposal is filed beside, the `ProposalTarget`, the path of the always-loaded
file) is what `dream::run_on_agent` builds per target, and the tool is the same
`ProposeInstructions::new(..).against(read_capped(file))` the API engine's
dream gets, so the proposal file is the same file. `initialize` says so in its
instructions; `remember` and the readers are unknown here, not hidden, since a
dream on this engine must not read the other chats or write to the inbox it is
draining. It needs no config dir and reads no registry. Documented with the
rest of the pass in [service-agent.md](service-agent.md) "Dreams and captures
on this engine".

**There is no approval layer.** On the API engine each of these calls goes
through `approval`; here the CLI's own permission system judges an
`mcp__nightloom__*` call like any other, and a gate of ours in front of theirs
would prompt twice — or, headless, deny once. A standing grant goes in
`~/.claude/settings.json`, under `permissions.allow`, as `"mcp__nightloom__*"`
(the way `mcp__openalex__*` already is on this machine), or per tool. Of the
~~four~~ five (2026-09-16), `search_chats`, `read_chat` and `context_status`
are read-only: the user's own logs and the turn's own figures, on
this machine, and nothing changes. `remember` appends one line to the memory
inbox — `Effect::Session` on the API engine, and the argument in `remember.rs`
for why that write needs no gate holds here too. `fetch_page` leaves the
machine and is the one to think about before allowlisting.
