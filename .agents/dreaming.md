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

- **Automatic scheduling.** A dream spends real money unattended; phase 1 is
  manual plus a startup line naming the pending count. If it earns
  automation, the trigger the evidence supports is a disjunction — backlog
  volume, or a compaction event (the moment raw history stops replaying) —
  not a wall clock.
- **Desktop surface.** A Dream button and the pending count belong in the
  rail; phase 2.
- **Benchmarking on LoCoMo.** 6.4% of its answer key is wrong and its judge
  accepts ~63% of wrong-but-topical answers. The honest measurement is our
  own: consolidated vault vs. full transcripts vs. plain grep over raw logs.

Related: [[../CLAUDE.md]] (knowledge vault sections), `crates/nightloom-service/src/observe.rs`,
`crates/nightloom-service/src/dream.rs`, `crates/nightloom-service/src/tools/remember.rs`.
