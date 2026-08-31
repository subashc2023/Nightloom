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
