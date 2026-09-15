# The usage ledger — what Claude Code has cost, read from files Nightloom does not own

`crates/nightloom-service/src/usage.rs`; Settings → Usage in the desktop app
(`docs/desktop-ui.md` §Usage). Nightshift backlog 045, 2026-09-14.

## What is read, from where

Three files under `~/.claude`, written by a user-global collector,
`~/.claude/usage-ledger.py`, which a LaunchAgent
(`com.swaraagsistla.claude-usage-ledger`) runs every six hours. **Nightloom
writes none of them and never runs the collector.** Their absence — a machine
where it has never run — comes back from `usage::summary()` as
`available: false` with a reason sentence, not an error, so Settings opens
either way.

| file | what | keyed by |
|---|---|---|
| `usage-ledger.csv` | per-day token counts from the Claude Code transcripts under `~/.claude/projects` | `(date, model, scope)` — date **UTC**, scope `main` or `subagent`, model the API id with `#fast` appended for a fast-mode request |
| `usage-rates.json` | USD per million tokens per model (`input`, `output`, `cache_read_mult`) and two global cache-write multipliers (`_write_mult_5m`, `_write_mult_1h`) | model id, exactly as the ledger spells it |
| `usage-surfaces.csv` | the desktop app's seven-day breakdown of the weekly limit by surface (Claude Code / chat / cowork / other) and the weekly caps, one row per snapshot, append-only | `as_of`, UTC |

The ledger holds **tokens only, never dollars**. Every count appears twice:
`_raw` (one transcript line per content block, each repeating the message's
usage — what Anthropic's dashboard shows, about 2.3× high) and `_dedup` (one
per API message id — what the API would bill). **Dedup is the billing basis**
and what every figure in Nightloom uses. The collector's own file is the spec
for all of this; `usage.rs` reproduces the semantics and a test pins its total
for a real day to what `usage-ledger.py report … --basis dedup` prints.

`~/.claude` is fixed — it does not follow `NIGHTLOOM_HOME` — because the files
are the user's, not this app's.

## The formula

For one ledger row and its model's rates `i` (input), `o` (output), `crm`
(cache-read multiplier), and the table's write multipliers `m5` and `m1`:

```text
cost = (in·i + out·o + rd·i·crm + w5m·i·m5 + w1h·i·m1) / 1e6
```

In words: uncached input at the input rate, output at the output rate, cache
reads at the input rate times the read multiplier (a tenth, for most
models), five-minute cache writes at 1.25× input, one-hour cache writes at
2× input; the token counts are per million, hence the division. Reproduced
in `usage::cost` in the same operation order, so the Rust figure and the
Python `claude_usage` alias agree to the cent. A model missing from the rates
table costs `None`, which the summary lists as *unpriced* rather than summing
as zero — the same stance `SessionCost::unpriced_exchanges` takes.

## Why it is not `Chat.price`

`Session::cost` sums prices *recorded at the time of each exchange*
(`docs/core.md`, `docs/service-engine.md` §"Smaller pieces"): a session's
cost is history, and history does not restate when a vendor changes a rate.
The ledger takes the opposite stance on purpose — the collector's docstring
says rate changes apply retroactively — so a figure here moves when the table
does. Both are right for what they measure; neither is fed the other's
number, and the pane says which one it is showing.

Every ledger dollar is an **API-equivalent**: the transcripts it reads were
mostly billed to a subscription, and the figure is what the same turns
*would* have cost on the API. That is the stance `docs/service-agent.md`
takes for the Claude Code engine's own per-turn estimate, and the pane's
first paragraph says so.

## What the summary carries

`usage::summary()` → `UsageSummary`: three windows on the dedup basis
(today; the last 7 days; the last 30 days — UTC, inclusive), each a total
and a per-model list with both scopes folded together, largest first; the
newest surfaces snapshot; the ledger's first and last dates; the CSV's mtime
as `updated_at` (when the collector last finished); and the models the ledger
counted that the rates table does not price. `summary_in(dir, today)` is the
same with the directory and the date as parameters, which is what the tests
use.

## Not done in this pass

Porting the collector (it depends on the desktop app's Chromium cache layout
and the `zstd` binary; nightshift blocker 060 kept it a sidecar); per-project
totals (the ledger has no project column); dollar caps that refuse turns.
