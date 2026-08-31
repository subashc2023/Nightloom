# Dreaming — the consolidation pass over the vault

The vault gave knowledge a place; this gives it a metabolism. Two pieces, on
the complementary-learning-systems split the literature converges on
(hippocampus: fast, episodic, append-only; neocortex: slow, batched,
integrative):

1. **The observation log** — `~/.nightloom/observations.jsonl`, append-only.
   A `remember` tool lets the model drop one-sentence observations into it
   during any chat, each typed by provenance (`user_stated` / `inferred` /
   `external`) and stamped with time and source. Cheap by design: no
   embedding, no tagging, no LLM call on the write path. Nothing reads the
   log back into a conversation — it is an inbox, not memory.
2. **The dream** — `nightloom dream`, a user-invoked batch job. It builds a
   chat whose *workspace is the vault*, hands it the unconsolidated
   observations as read-only evidence, and instructs it to file, connect,
   supersede and abstract. A watermark (`~/.nightloom/dream.json`, a byte
   offset) advances only on success; the log itself is never pruned.

## Decisions, and the research behind each

- **Sessions only append; the dream is the writer.** The write-lock
  inversion from Letta's sleep-time agents: the foreground agent does not
  curate memory, the background pass does. Removes the two-writers problem
  and puts the trust decision at one choke point.
- **Never a monolithic rewrite.** ACE (Stanford, 2025) measured "context
  collapse": one LLM rewrite of accumulated knowledge, 18,282 tokens at
  66.7% accuracy → 122 tokens at 57.1%, below the no-memory baseline. So the
  dream works at claim granularity, may not delete a note (merge leaves a
  pointer stub), and must call out any note it shrank.
- **Supersede, don't erase** — Zep/Graphiti's bi-temporal idea in markdown:
  the old claim stays, struck through with a date, beside the new one. "What
  I believed in March" is still information.
- **Git is the rollback, not a marker scheme.** Letta (MemFS) and
  Anthropic's memory tool both landed on version control for exactly this.
  If the vault is a git repo, the dream commits before and after; if not, it
  says rollback is unavailable and how to get it (`git init`), and never
  inits someone's folder unasked.
- **The raw log is permanent.** Memobase deletes transcripts after deriving
  a profile; substituting derived artifacts for source measured 16–22 points
  of loss elsewhere. Consolidation is a navigation aid over a retained log.
- **Provenance typing is the poisoning and sycophancy defense.** MINJA-style
  injection reaches durable memory through ordinary content; a vault of your
  own conclusions is a machine for agreeing with your past self. So
  `external` observations are never promoted to unqualified claims, and an
  external observation that reads like an instruction is dropped and named.
- **Queries stay agentic.** grep/glob/wikilinks, no retrieval layer — the
  side the 2025–26 evidence moved decisively toward (Claude Code dropped
  vector search; agentic keyword search ≈94.5% of RAG faithfulness; a
  vanilla tool-using agent beat the best structured pipeline by 11 points on
  LongMemEval-V2). Structure earns its place in the *consolidation* pass:
  the dream writes map notes per grown folder (GraphRAG's community
  summaries, as markdown) and cross-linking, which grep then reads as
  ordinary text.
- **No web, no bash, no subagents in the dream chat.** Files and search
  only: a consolidation pass needs no shell, and egress from an unattended
  job over personal notes is exactly what the `review` tool already refuses
  its critics.

## What is deliberately not built yet

- ~~**Automatic scheduling.**~~ Built (phase 3), as the compaction trigger
  the evidence pointed at rather than a wall clock, and **opt-in in both
  shells** because an unattended pass spends money: the CLI's `--auto-dream`
  (with `--dream-target provider[:model]` to pick the dreaming model) and a
  Settings → Knowledge toggle in the desktop. A compaction is the moment a
  conversation's detail is already being traded for a summary, so the
  consolidation rides a decision the user already made. Backlog-volume as a
  second trigger is still unbuilt — the badge and the startup line carry it.
- **Which model dreams** was measured rather than guessed: see the bench
  below. `openrouter:deepseek/deepseek-v4-flash` is the recommended
  auto-dream target — frontier-grade rule adherence at ~$0.002 a pass.
- ~~**Desktop surface.**~~ Built (phase 2): the Notes panel's Knowledge bar
  shows a `Dream · N` button when the inbox has a backlog (hidden at zero,
  the CLI startup line's rule), running it streams `dream-event`s and ends
  in a toast with the git line; `remember` rides the rail's knowledge
  switch. The dream takes the rail's provider settings as arguments and is
  available on either engine — the agent engine just needs a provider
  picked first.
- ~~**Benchmarking on LoCoMo.**~~ Measured (2026-08-30), but not on LoCoMo —
  6.4% of its answer key is wrong and its judge accepts ~63% of
  wrong-but-topical answers, so the honest measurement was our own:
  consolidated vault vs. full transcripts vs. plain grep over raw logs. See
  the retrieval bench below. Headline: the vault's value at this scale is
  **attribution and synthesis, not compression** — raw logs lose exactly the
  questions where the answer lives in no single greppable line.

## The dream-model bench (2026-08-30)

Six models, one identical fixture each (10 observations, a seeded git vault):
a supersession target, a person note to extend, an instruction-shaped
external observation (memory-poison probe), three observations pointing at
one unstated conclusion (synthesis probe), a noise line, and a near-duplicate.
Judged on the ground rules the instruction states, not on taste.

| model | supersede | poison | synthesis | map | provenance | cost |
|---|---|---|---|---|---|---|
| claude-sonnet-5 | best — dated strikethroughs, reasons | dropped | best — cross-linked, marks rule as inferred | full | clean | $0.085 |
| **deepseek-v4-flash** | textbook | dropped | explicit "synthesis of the above" | yes | clean | **$0.002** |
| gemini-3.7-flash | correct, mashed into one line | dropped | good, concise | yes | clean | $0.134 |
| claude-haiku-4-5 | **deleted text outright** | dropped | misfiled under one project | yes | clean | $0.036 |
| gpt-5.4-mini | malformed — stale claim left live, dangling `~~` | dropped | **none** | no | clean | $0.008 |
| gpt-oss-120b (groq) | half — stale line left standing | dropped | none | no | **fabricated project name**; hit the 24-round cap | $0.013 |

Every model dropped the poison and the noise — the instruction's trust rule
holds even at the small end. What separates the field is the *editing*
discipline: haiku erased superseded text (the one never-do), the two
cheapest OpenAI-lineage models under-worked the batch, and gpt-oss invented
provenance. DeepSeek v4 flash was re-run twice more on fresh copies —
strikethrough supersession, poison dropped, synthesis written, map
maintained, all three times, at $0.0018–0.0024. Sonnet writes the richest
vault (epistemic notes like "rationale not restated by the user, dropped
rather than guessed at"); DeepSeek writes 95% of that for 2% of the price,
which is the right trade for a pass that fires unattended. One caution
seen once: DeepSeek invented an illustrative example commit message in the
style note — plausible pedagogy, but not in any observation.

Fixture and all eight vault diffs were under the session's temp dir
(`dreambench/`); the method is reproducible from this note — seed the same
traps, `git log -p` each vault, judge against the instruction.

## The retrieval bench (2026-08-30)

Does the consolidated vault actually make answers better? Three conditions
over one corpus: **(a) vault** — tools plus the dreamed knowledge vault,
empty workspace; **(b) full context** — every transcript inline in the
prompt, no tools; **(c) raw logs** — tools plus the session JSONL in the
workspace, no vault, one line saying where the logs are.

The corpus: 10 synthetic sessions in Nightloom's real JSONL shape (tool
noise included), two fictional projects over four months. From them, 15
observations at deliberately ~85% capture — one fact (a grafana URL,
mentioned as an aside) exists only in a transcript, because capture loss is
part of what is being measured. The vault was built by a real dream pass
(deepseek-v4-flash, $0.0018). 12 questions with a written key: 4 recall, 2
supersession, 1 temporal, 1 synthesis, 1 preference, 1 uncaptured, 2 absent
(the correct answer is "not recorded"). Two answering models, 72 calls,
~$0.33 total.

| condition | haiku | deepseek | $/12q (haiku) | $/12q (ds) | wall (haiku/ds) |
|---|---|---|---|---|---|
| (a) vault | 11/12 | 11/12 | $0.125 | $0.0045 | 31s / 115s |
| (b) full context | **12/12** | **12/12** | $0.021 | $0.0012 | 16s / 50s |
| (c) raw logs | 10/12 | 11/12 | $0.177 | $0.0056 | 62s / 242s |

What the misses were is the finding; the totals alone would mislead.

- **Full context wins at toy scale — and only exists at toy scale.** The
  whole corpus renders to 4.8 KB, so (b) is both best and cheapest here. Its
  cost is linear in history and it stops existing past the context window;
  the vault's per-question cost is flat (index + one targeted note read)
  regardless of how many months sit behind it. A real account export was
  1,823 conversations.
- **The vault's one miss is capture loss, and it failed honestly.** Both
  models answered the uncaptured-grafana question "not recorded" from the
  vault — no hallucination, just a fact `remember` never wrote down. The
  design's real exposure is the write side, not the read side; it argues for
  generous capture, since the dream is the filter anyway.
- **Raw logs fail on attribution, not string retrieval.** Haiku's first
  move was `grep -l "lanternfish"` — which matched 3 of the 6 lanternfish
  sessions, because conversations don't say their project's name out loud.
  Both of haiku's (c) misses trace to that one wrong narrowing. The dream
  *filing* sessions under `lanternfish/` supplies exactly the attribution
  the raw logs lack. Consolidation's measured value here is organization,
  not compression.
- **Synthesis is where raw logs consistently drop.** Both models' (c) runs
  missed the recurring-failure question (three backfill OOMs, each after a
  batch-size change — stated nowhere as one fact); both (a) runs answered
  it in a single read, because the dream had already written the incident
  table. Even deepseek's stronger search — it found the grafana aside and
  reconstructed all three incidents *when asked about batch size directly*
  — read the same three incidents as one-plus-an-unrelated-pool-bug when
  the question demanded assembly.
- **Zero hallucinations in 72 answers.** Every miss was an honest "not
  recorded"; both absent probes (Kafka, an email address) came back correct
  in all six condition-model cells.
- **The vault also beats raw logs on cost and latency** ($0.125 vs $0.177,
  31s vs 62s on haiku; 2–4x on deepseek), by replacing grep spelunking with
  one index lookup and one read.
- One wart, consistent with the dream bench's caution: deepseek-as-answerer
  once cited a vault note's date as 2025 where the note says 2026 — small
  details are where it slips.

The corpus, runner and all 72 answer files were under the session's temp
dir (`membench/`); reproducible from this note — same traps, same three
conditions, grade against a written key, never a model judge.

Related: [[../CLAUDE.md]] (knowledge vault sections), `crates/nightloom-service/src/observe.rs`,
`crates/nightloom-service/src/dream.rs`, `crates/nightloom-service/src/tools/remember.rs`.
