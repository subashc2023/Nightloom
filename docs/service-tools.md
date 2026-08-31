# nightloom-service — the built-in tools

`tools/` hosts the built-ins shared by all shells, grouped by wire rather than by
name: `files.rs` (`read_file` / `write_file` / `edit_file` / `list_dir`),
`search.rs` (`glob` / `grep`), `shell.rs` (`bash`), `todo.rs` (`todo_write`),
`compact.rs` (`compact_context`), `task.rs` (`task`), `review.rs` (`review`),
`web.rs` (`web_fetch` / `web_search`), `remember.rs` (`remember`), and
`current_time` inline in `mod.rs`. `builtin_in(root)` is the whole set in one
call.

## Classification and descriptions

**Effect classification is part of adding a tool**, and a test pins the whole
table: `ReadOnly` for `read_file` / `list_dir` / `glob` / `grep` /
`current_time` and for `review`, which is read-only because its sub-chat is
stripped to read-only tools; `Session` for `todo_write` / `compact_context` and
for `remember`, a durable write that is still `Session` because the inbox is
quarantine and the dream pass is the gate; `Mutating` (the default) for
`write_file` / `edit_file` / `bash`, for `task`, which can reach anything its
own tool set allows, and for `web_fetch` / `web_search`, where a request the
model composed leaves the machine. The test guards the reverse risk — a tool
quietly talked *down* to `ReadOnly`. `task`, `review` and the two web tools are
argued in their own sections below; `remember` is argued in
[service-data.md](service-data.md).

**Tool descriptions are prompt engineering, not documentation.** They say *when*
to reach for a tool and what to prefer (edit over rewrite, `grep`/`glob` over
shelling out to `find`). Error strings are addressed to the model too — a failure
comes back as an `is_error` tool result it must act on, so `edit_file`'s
ambiguity error tells it to extend `old_string` rather than retry blind. A test
asserts no description carries stray wrapping whitespace.

**`replace_all` refuses to reach inside a longer name**, and the measurement is
the argument. `replace_all` waives the uniqueness contract on purpose, and it
replaces a literal substring rather than a word — so renaming a bare
`fetch_rows` to `load_rows` rewrites a neighbouring `fetch_rows_v1` into
`load_rows_v1`, writes the file, and reports success. The eval suite's
`rename-across-files` trap is exactly that neighbour, and across 59 attempts on
five models the flag was reached for five times with **a bare identifier every
one of them**; none landed on the file holding the decoy, which is where the
calls fell rather than a judgement any model made. Two of the five came from one
`gpt-oss-120b` attempt.

So `edit_file` now refuses that call and names the neighbour it would have
broken. The description was fixed first and is not enough on its own: it is
advice, and the two models that actually sprang the trap (`deepseek-v4-flash`
and `gemini-3.1-flash-lite`, once each in ten) did it by reading the file and
hand-writing the rename, which no description reaches and this guard does not
catch either.

Only a needle that begins or ends in an identifier character can be swallowed,
so `fetch_rows(` and `= 1;` never trip it — and that is also the way out, which
the error says: bound the name, or give each longer name its own call. The cost
is real and accepted: a deliberate substring rename across a family of names
(`Color` → `Colour` over `ColorPicker`) now takes one call per name. That is the
trade — the refusal is recoverable and comes back as text the model can act on,
where the spread rename is a silent corruption that reports success.

## `tools/root.rs` — path confinement

Every path-taking tool resolves its argument against a `Root` and refuses
anything outside it. **A workspace plus at most one named tree** — never an
open-ended set. The workspace is the default, and a `Root` built without the
second tree behaves exactly as it always did.

The second tree was arrived at twice, and the occasions are worth telling apart
because the first was wrong. It briefly grew one for a *docspace* that had moved
to `~/.nightloom` and could be indexed into the system prompt but never opened;
putting the docspace back at `<workspace>/.agents` was the better fix, since a
note is then an ordinary relative path inside a tree the tools were already
rooted at.

The second is the **knowledge vault**, where that argument does not apply: it
holds what the *user* knows rather than what this folder contains, so there is no
workspace to move it into. A thing that must be reachable from every project, and
from a chat with no project at all, cannot live inside any one of them. So it is
addressed by the alias `VAULT_ALIAS` (`@kb`); `resolve` answers the alias before
anything else and `show` emits it, and every path-taking tool inherits the vault
with no new tool and no retrieval layer.

Three rules keep it honest:

- the **workspace is checked first**, so a vault nested inside one resolves and
  renders as an ordinary workspace path — addressing never depends on what
  happens to exist;
- a bare `grep`/`glob` with no `path` still walks the **workspace only**, so
  reaching the vault is explicit and today's searches are byte-identical for
  anyone not asking about it;
- the alias is matched on a **path component**, so `@kbd/notes` is an ordinary
  file.

`Root::path_hint()` is the clause the six `path` descriptions append when a vault
is present. Not decoration: `grep` and `glob` could already reach the vault while
their descriptions said "relative to the workspace root" — the docspace's own
silent-wrongness bug one directory over. The alias shadows a literal `@kb` at the
workspace root; documented rather than defended against, the alternative being
addressing that resolves differently depending on what exists.

**Two checks, because neither alone suffices**: *lexical* normalization of `..`
and `.` without touching the disk (which is what `write_file` needs, since
`canonicalize` errors on a path that does not exist yet), and *real*
canonicalization of the deepest existing ancestor (which catches a symlink
pointing out). Tools then operate on the same normalized path they checked, so
containment is judged on **where a path lands, never on how it was spelled**.

`show` renders a path relative to the workspace — or as `@kb/…` for one in the
vault — and is what the model passes back on its next call, so it has to
round-trip through `resolve`. That is why the search tools report through it, and
why the alias has to be *emitted* rather than merely accepted.

`builtin()` roots at cwd; `builtin_in(root)` takes anything `Into<Root>`, so a
shell attaches the vault with `Root::new(ws).with_vault(dir)` and everything
downstream is unchanged.

**It is a guard rail, not a sandbox**: TOCTOU is uncovered, and `bash` is not
confined at all — only its working directory is set, and its description says so
plainly.

## Subagents (`tools/task.rs`)

`Chat::enable_subagents(factory)` adds a `task` tool that runs a focused
instruction in a nested `Chat` with its own in-memory `Session`, returning only
its final message.

**The point is not parallelism, it is *forgetting*** — a question that costs
twenty file reads and one sentence to answer should not spend the parent's window
on the nineteen intermediate results. Verified live: the parent log for a
delegated search held four events (user, `task` call, one-line result, answer)
while the subagent's own reads never touched it.

Two things are **lent** from the spawning turn through a `TurnHandle` refreshed
each round, so the order a shell configures `Chat` in cannot matter: the
cancellation token, and the approver. The approver is the security-relevant half
— a subagent that did not inherit the policy would be a door beside the approval
gate, letting the model reach every mutating tool by asking a subagent to run it,
and inheriting the *instance* also carries the user's "always allow" grants.

The engine strips the `task` tool from whatever the factory returns, so a factory
handing back the parent's whole tool set cannot open an unbounded recursion. The
factory is fallible (`Fn() -> Result<Chat, String>`) because a build failure
should reach the model as a tool error, not panic the process.

## Cross-model review (`tools/review.rs`)

`Chat::enable_reviews(reviewers, root)` adds a `review` tool that runs a nested
`Chat` **on a different provider** over a document this one wrote.

### Why a different vendor

An hour of planning with one model produces a doc a different vendor picks holes
in on first read, and three separate things cause that:

- a **different prior** — models fail differently, and systematically. The large
  effect, and the only one a same-model critic cannot supply at all.
- **no sunk context** — the author reads the doc through the memory of having
  written it, where a cold reader sees only the artifact, which is also all the
  implementer will ever see. So a doc that only makes sense given the
  conversation is itself the finding.
- evaluating simply not being generating.

A same-model "check your work" call gets the third and part of the second, which
is why it feels like it does nothing.

### Shape

It takes a **path, not text**: the reviewer reads the file and the codebase
around it with real tools, so it can *verify* rather than opine. A proposal that
only exists in the conversation is refused with the observation that it could not
be implemented from there either.

Findings come back **as text into the turn and are never written to a file**. A
`plan.review.md` in the docspace goes stale the moment the parent acts on it and
is then indexed into the next chat's system prompt, advertising problems that
were fixed; the session log is the durable record and the revised document is the
artifact meant to survive. Returning inline is also the only shape that lets the
parent do the useful half — half of what a cold reader produces is an objection
the doc settles two sections down, and the parent has `grep` and the same
workspace to check with. The description carries the other half: findings are
claims, not instructions, and a document rewritten to satisfy every objection is
longer, hedged and worse than the one it started as.

The reviewer's instruction is composed by the tool rather than passed through
from the parent, which is the whole reason this is not `task` with a different
prompt — ask a model "is this plan good?" and it says "looks solid, consider
adding tests". It demands the *condition* under which each defect bites (what
separates a defect from a preference), demands the files be opened before any
claim about them, and states up front that finding nothing is a valid answer,
because a reviewer that believes it owes you a list will produce one.

An empty reply names **which** way the turn ended (round cap, or no text at all
with the stop reason): the two need different responses from the parent and look
identical as an empty string. Seen live, a reviewer came back empty, the old
message guessed "may have run out of tool rounds", and the parent spent two rounds
hunting a file that was never missing.

### `Effect::ReadOnly`, made true

**`Review` strips the sub-chat to read-only tools itself**, rather than trusting
the factory, and that is what makes `Effect::ReadOnly` on it *true* rather than a
classification talked down. A critic that can edit is a second author.

`review` is additionally stripped by name, since both shells build reviewers with
the same function they build the main chat with and a reviewer that can order a
review is an unbounded fan-out at a provider call per level; `task` falls out for
free, being `Mutating`.

Two things follow from the honest classification: the approval gate answers it
without asking (the cost being that a call against another vendor is never
prompted for, which the description carries instead), and the engine overlaps
*adjacent* read-only calls — so **the panel is not a separate feature**.

Verified live: one round of three `review` calls came back in 45s where one alone
took ~35s, each attributed, and the parent ranked the findings all three had
raised independently above the ones only one had. The first live run is the shape
it is for — the plan claimed `cache.py` already evicted its oldest entry, the
reviewer opened the file and said it did not, and the parent checked before
agreeing.

### The bench (`tools::bench`)

Which reviewers exist is a **curated table** (`BENCH`) rather than whatever keys
are set, and that is a correctness fix and not only a shorter prompt: enumerating
credentials listed Groq's `openai/gpt-oss-120b` beside OpenAI's own model as two
different reviewers when they are one lineage behind two pipes, and listed
`openrouter/auto` — a router, which has no fixed prior and so cannot be a second
one.

The unit being bought is *a lineage*, so the table is one row per lineage (claude,
gpt, gemini, grok, deepseek) and a test pins that no two share one.

**OpenRouter is preferred whenever its key is present and takes the whole bench
with it**, rather than filling gaps in a native list: one key buys four distinct
priors, billing lands in one place, and the tool description stops changing shape
with whichever native keys happen to be exported. Without it each row falls back
to its own vendor and the ones with no adapter here drop out — nothing is ever
substituted, a bench of two being the honest answer to two keys.

The row **under review** is always dropped, and the lineage is read off the model
id rather than the provider, since `openai/gpt-oss-120b` on Groq is OpenAI's and
`anthropic/claude-sonnet-5` through OpenRouter is Claude whichever pipe carried
it. `tools::bench` is the whole decision and both shells call it, leaving each
with only the half a shell can do — build a `Chat` for a named provider and
model.

## Web access (`tools/web.rs`)

`tools::web_tools(key)` adds `web_fetch`, and adds `web_search` only when a
search backend has a key.

**Both are `Mutating`, and that is the design rather than a formality.** Reading
a page reads like a read, and every other read here is `ReadOnly` — but the reads
that earned that classification are confined by a `Root`, and there is no `Root`
for a network. The gap is not theoretical: the model composes the URL out of
whatever it has read, so a secret it saw two rounds ago can leave in a query
string, and `169.254.169.254` is a cloud metadata endpoint a workspace
confinement has nothing to say about. `ReadOnly` would mean neither call is ever
shown to a user *and* would let it overlap its neighbours.

What the classification buys is exactly one thing — somebody sees the URL before
it is sent — and what it does not buy is worth saying out loud: `--no-approval`
is no gate at all, the same way it is none for `bash`.

`http`/`https` are the only schemes accepted, which rules out `file://` reaching
the disk through the one tool with no root. Loopback and private addresses are
deliberately **not** blocked, since "fetch what my dev server is rendering" is a
real use and the gate above is the honest place to judge it.

One consequence falls out for free and is wanted: `review` strips its sub-chat to
read-only tools, so a reviewer cannot reach the network — a critic that fetched
would be un-prompted egress on a second vendor's bill.

### The HTML extractor is hand-rolled

Like the FNV-1a in `project.rs` and reading `.git/HEAD` rather than spawning git:
a real parser is a large transitive tree for one tool whose output is read by a
model rather than rendered by a browser.

What matters is that `<script>`/`<style>` bulk never reaches the context, that
structure survives as `#` headings and `-` list markers, that `<pre>` keeps its
whitespace (a fetched code sample being the common case), and that links keep
their URLs **resolved against the landed URL** so the next call has somewhere to
go.

Where it gives up it says so — a page that extracts to nothing is assembled by
JavaScript, and reporting that is the difference between the model trying the
site's API and trying the same URL three more times.

Two whitespace rules are pinned by tests because both are invisible in the markup
and very visible in the output: inserting a space the source did not have turns
`…(url).` into `…(url) .`, and dropping one it did have runs `the <b>fast</b>
cat` together.

Truncation carries **the offset that continues it** rather than advice — unlike
`grep`, whose answer is to narrow the pattern, a truncated page has nothing to
narrow. A failed response's body is read and returned, because for an API it *is*
the explanation of what was wrong with the call, and it goes through the same
extraction: a failing HTML page clipped raw is 400 characters of doctype and
stylesheet links.

### Search is a curated table behind a key

Tavily, then Brave, then Exa — and *absent* without one, since advertising a tool
that fails every call spends prompt and buys a round trip to find that out.

There is no vendor-neutral search API, so something has to be chosen. The
providers' own server-side search (Anthropic's `web_search`, Gemini grounding)
was rejected because those are *provider* features and a tool that vanishes when
you change the model dropdown would break the one promise the desktop makes
loudest; scraping an engine's HTML with no key was rejected because nothing else
here is substituted either.

`search_backends()` names the choice separately from `web_tools()` so a shell can
*say* where queries go without re-deriving it — a startup line naming Brave while
the tool queried Tavily would be worse than no line.

**Several keys make a chain, not a fan-out.** Every backend with a key is tried
in turn until one answers, and one that answers with a dead key or a spent plan
leaves the chain for the life of the process rather than costing a wasted request
on every later search. Querying all three per search and merging them is wrong in
the direction that matters: it triples the requests, so it empties three free
tiers in the time one would have lasted — the exact inverse of what a second key
is for. It also reads worse, since Tavily returns extracted page content, Brave
an index snippet and Exa a semantic excerpt, so a merged list is one where the
model cannot tell how far to trust a snippet from its shape.

What retires a backend and what merely skips it are **different questions with
different costs**. A 401/422/402, or a body naming quota or credits, is permanent.
A **429 is not** — Brave's free tier allows one query a second, so retiring on it
would throw away a working key on the first fast round of tool calls; the query
falls to the next backend while the next query starts at the head again. An empty
result set is not a failover either, since a query that matched nothing at one
index usually matches nothing at the next, and finding that out spends the tier
the chain exists to stretch.

A failover **says so in the result**, above the hits: silent, a dead key goes
unnoticed for as long as the spare holds out, and the model's answer would name a
vendor the user did not think they were using.

The tool description names the **whole** chain and is fixed for the life of the
tool. A user finds out there where their queries go, and naming whichever backend
is currently at the head would rewrite the tool definition mid-session — the
outermost layer of the prompt cache — so a failover would silently cost a full
cache miss on every remaining turn.

**A rejected key must not read as a bad query**: verified live, Brave answers an
invalid token with **422** where Tavily and Exa answer 401, so `advice()`
consults the body as well as the status, and a 4xx that is not an auth failure
still says "the same query will fail again" rather than leaving the model to
rephrase until the round limit.

Keys are `TAVILY_API_KEY` / `BRAVE_API_KEY` / `EXA_API_KEY`, or the desktop's
credential store.

## Killing a shell is not killing the command (`tools/shell.rs`)

`kill_tree`, `PUMP_GRACE`.

A shell spawns the program it was given as its own child, which inherits the
pipes and does not die with its parent. So `child.kill()` left the actual work
running and its output handle open — and the pump then waited on that handle,
which is the wait the kill existed to end. Measured on Windows: a command killed
after **500 ms** returned **29.2 s** later, when its `ping -n 30` finally
finished, so `timeout_ms` was bounding nothing and neither would an interrupt.

The second cost is worse than the wasted work. A read on a child's pipe runs on a
blocking-pool thread where nothing can interrupt it — not `abort`, not dropping
the task — so a surviving grandchild pins that thread until it exits and the
runtime's own shutdown waits for it. Interrupting a build and then quitting would
hang on the build.

`taskkill /T /F` is the tree-walking kill Windows offers without a job object
(which would mean a `windows-sys` dependency and a handle to manage); it is
best-effort and `child.kill()` follows either way, so the ordinary case does not
depend on an external program. Unix keeps the plain kill — `sh -c` execs a simple
command in place rather than forking, so the common case has no grandchild, and
the general fix there is a process group, which needs `libc` for `killpg`.

Under both sits `PUMP_GRACE`: output is read into shared buffers rather than out
of the task's return value, so whatever was captured is reachable even when the
reader cannot finish, and a read that has not ended two seconds after the kill is
abandoned with the result saying the output may be incomplete.

The result is assembled the same way on both platforms: the exit code leads, then
stdout, then anything written to stderr under a `[stderr]` marker. The marker is
not decoration — the two streams are drained into separate buffers and joined
afterwards, so everything a command sent to stderr arrives in one run at the end
rather than interleaved where it happened, and unlabelled it reads as the tail of
the command's own output. Seen live: `fatal: not a git repository` sat under
three lines of unrelated stdout with nothing to say it came from anywhere else.
It names the stream and claims nothing about failure, plenty of working commands
writing there.
