# nightloom-evals

Two harnesses that fail independently, answering different questions. Both spend
real money against real models and neither is in CI.

- **`probe`** asks whether a stream is healthy.
- **`eval`** asks whether a model can finish a job with these tools. Reach for it
  when you change the turn engine, the tools, or their descriptions — it is the
  only check that exercises a whole tool loop, and it is what caught the round
  cap.

## The agentic suite (`task.rs` + `suite.rs`)

A model gets a throwaway workspace, the built-in tools and an instruction, and
afterwards **the disk is inspected**.

**No model grades another.** A check is a `fn(&Path, &str) -> Result<(),
String>`, so a pass is a fact rather than an opinion; a suite that judged by
asking a model would inherit the failure it exists to detect.

Every task's answer is invented, so a model that guesses is wrong and one that
reads is right. Every workspace is per *attempt*, since the second run would
otherwise start from the first one's edits.

`runs` is part of the spec rather than an afterthought: these are sampled systems
and the interesting number is a pass rate, so a suite reporting 1/1 as "passes"
would read as a regression the next time it flipped.

Failures are classified — a wrong answer sends you to the model, an exhausted
round limit to `max_rounds`, and a reply with no text at all to the adapter. All
three look identical as an empty string in the check's own message.

**Every agentic task carries a trap**, all four of them: a decommissioned file
with the same phrase, a config that must survive an in-place edit, a
`fetch_rows_v1` that must *not* be renamed, and a file that does not exist and
must not be invented or created. With the three shape tasks below that is the
whole suite of seven.

### Three shape tasks

`one-call`, `three-sequential`, `three-parallel` ask a different question: not
*can it finish the job* but *can it make this shape of tool call*.

They need something the disk cannot supply — three files read in one batch and
three read one after another leave a workspace identical in every byte — so a
`Check` takes an `Outcome { dir, answer, trace }`, and `Trace` records the calls
**round by round** (`TurnEvent::Usage` is the round boundary: it arrives after
the stream ends and before any tool runs).

`three-sequential` is forced by content rather than by asking nicely: nothing
names `relay/2c/node.txt` except `relay/7f/node.txt`, which nothing names except
`start.txt`, and the decoy codes a glob or grep turns up cannot be told apart
without following the trail. Extra rounds are fine — the check asks that the
three reads happened in increasing round order, not that nothing else did, so a
model that lists the directory first is measured on chaining rather than on
caution.

### A shape instruction a model cannot verify it followed is one it can loop on forever

Asked for "one batch of parallel tool calls", gpt-5-mini issued exactly the three
calls wanted and then reported, in its own reasoning summary, *"I initially used
the read_file function sequentially… I realize I should use
`multi_tool_use.parallel` instead"* — and reissued the identical batch twenty
times, hunting an OpenAI-internal tool that is not on the request. Twenty rounds
and 4x the cost, with the correct answer at the end.

Ruled out as a harness fault by elimination: the same model over
`chat/completions` finished in one round, a non-reasoning model on Responses
finished in one round, and a proxy capture of the round-2 body showed every
`function_call` correctly paired with its `function_call_output` by `call_id`.

The task now describes the *situation* ("nothing here depends on anything else")
and lets the shape follow, which is what the rest of the suite already did.

### Two findings from running it

Both the kind a unit test cannot produce.

**`max_rounds` was 8 and silently truncated ordinary work.** The four-file rename
took Gemini 2.5 Flash ten rounds, so at 8 it was cut off mid-task on every
attempt while working correctly — indistinguishable, in the transcript, from a
model that could not do it. Now 24.

**A check that matched `n't` failed a correct answer** written with a curly
apostrophe, which is the expensive direction for an eval to be wrong in: a false
failure sends someone hunting a bug that is not there. Hence `normalize()`, and a
test pinning the exact observed reply.

## The probe (`probe.rs`)

Runs a spec against any `Provider` and produces a `ProbeReport`: TTFT (measured
from before the request, so it includes connection time), thinking and text delta
counts, usage accounting, stop reason, an answer-substring check, and
diagnostics. Diagnostic entries prefixed `note:` are informational; anything else
fails the probe. JSON reports land in `.nightloom/probes/`.

Reach for it when adding or debugging an adapter — it is the project's
verification loop for streaming behaviour (thinking deltas present, usage adds
up, stop reason set, stream properly terminated). The probe deliberately does not
wrap its provider in `Retry`, since retries would distort TTFT.

Its tool check (`ProbeSpec.tool_check`) is a two-leg fixture: the model must call
`lookup_codeword`, and the second leg's answer must contain the fabricated
codeword.
