//! Agentic task evals: can a model actually finish a job in this harness?
//!
//! The probe measures whether a *stream* is healthy. This measures whether a
//! turn is useful — the model gets a workspace, a set of tools and an
//! instruction, and afterwards the disk is inspected. That difference matters
//! because the two fail independently: an adapter can stream flawlessly while
//! the model never edits the right file, and a model can do the job while the
//! adapter drops half its reasoning.
//!
//! # Why every task is checked programmatically
//!
//! No model grades another model here. A check is a function over the
//! workspace and the final message, so a result is a fact rather than an
//! opinion, and a suite that judges by asking a model would inherit exactly
//! the failure it is supposed to detect.
//!
//! # Why runs repeat
//!
//! One run of one task tells you almost nothing: these are sampled systems,
//! and the interesting number is a pass *rate*. A suite reporting 1/1 as
//! "passes" would flip to "fails" on the next invocation and read as a
//! regression, so `runs` is part of the spec rather than an afterthought.

use nightloom_core::Session;
use nightloom_service::{Chat, TurnEvent};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

/// How much of a call's arguments to keep.
///
/// Enough to say *which* file a `read_file` read, which is all a shape check
/// asks; not enough for a `write_file` to carry a whole generated file into
/// every report.
const CALL_INPUT: usize = 256;

/// Everything a check gets to look at: the workspace as the model left it,
/// what it said last, and what it did to get there.
pub struct Outcome<'a> {
    pub dir: &'a Path,
    pub answer: &'a str,
    pub trace: &'a Trace,
}

/// Verdict on one finished attempt.
pub type Check = fn(&Outcome) -> Result<(), String>;

/// One tool call the model made.
#[derive(Debug, Clone, Serialize)]
pub struct Call {
    pub name: String,
    /// The arguments as JSON, truncated to [`CALL_INPUT`].
    pub input: String,
}

impl Call {
    /// Whether the arguments mention `needle`, path separators normalized.
    ///
    /// The same file reaches a tool as `relay/2c/node.txt` from one model and
    /// as an absolute Windows path from another, and a check that spelled the
    /// difference out would be asserting something about the platform rather
    /// than about the model.
    pub fn mentions(&self, needle: &str) -> bool {
        slashes(&self.input).contains(&slashes(needle))
    }
}

fn slashes(s: &str) -> String {
    // Twice over: a backslash is one character in a path and two in the JSON
    // the path was serialized into.
    s.replace("\\\\", "/").replace('\\', "/")
}

/// What the turn did, round by round.
///
/// The disk cannot answer some questions. Whether three files were read one
/// after another or all at once leaves exactly the same workspace behind, and
/// it is the difference between a model that chains tool calls and one that
/// batches them — so a suite that only inspected the disk could not see the
/// thing these tasks exist to measure.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Trace {
    /// One entry per round, in order; a round with no calls is an empty entry.
    pub rounds: Vec<Vec<Call>>,
}

impl Trace {
    pub fn total_calls(&self) -> usize {
        self.rounds.iter().map(|r| r.len()).sum()
    }

    /// How many rounds made at least one call — the length of the chain.
    pub fn rounds_with_calls(&self) -> usize {
        self.rounds.iter().filter(|r| !r.is_empty()).count()
    }

    /// The most calls the model issued in a single round — the width of the
    /// widest batch, and the only evidence that it parallelized at all.
    pub fn widest_round(&self) -> usize {
        self.rounds.iter().map(|r| r.len()).max().unwrap_or(0)
    }

    /// Calls per round, empty rounds dropped: `"1,3"`. For error messages,
    /// where the shape *is* the diagnosis.
    pub fn shape(&self) -> String {
        let widths: Vec<String> = self
            .rounds
            .iter()
            .filter(|r| !r.is_empty())
            .map(|r| r.len().to_string())
            .collect();
        if widths.is_empty() {
            "no tool calls".to_string()
        } else {
            widths.join(",")
        }
    }

    /// Which round first called a tool matching `matches`.
    pub fn first_round_where(&self, matches: impl Fn(&Call) -> bool) -> Option<usize> {
        self.rounds.iter().position(|r| r.iter().any(&matches))
    }
}

/// One job to give a model.
pub struct Task {
    pub name: &'static str,
    /// What the model is told. Written as a user would write it, deliberately
    /// — a task phrased to name the tool it wants tests the harness's plumbing
    /// rather than the model's judgement.
    pub instruction: &'static str,
    /// Files laid down before the run, relative to the workspace root.
    pub files: &'static [(&'static str, &'static str)],
    /// Whether the task succeeded. Runs after the turn, against the workspace
    /// and the final assistant message.
    pub check: Check,
}

/// What one attempt did.
#[derive(Debug, Clone, Serialize)]
pub struct Attempt {
    pub ok: bool,
    /// Why it failed the check, or how it failed to run at all.
    pub failure: Option<String>,
    pub rounds: u32,
    pub tool_calls: u32,
    pub denied_calls: u32,
    /// Whether the turn ended by exhausting `max_rounds` rather than because
    /// the model was finished. Reported separately because it is a different
    /// diagnosis from a wrong answer: the model was still working, and the
    /// harness stopped it. Without this, both surface as an empty reply.
    pub hit_round_limit: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// USD, when the model has a verified price.
    pub cost: Option<f64>,
    pub elapsed_ms: u64,
    /// The calls, round by round. Kept in the report as well as handed to the
    /// check: when a shape task fails, the shape is the whole explanation.
    pub trace: Trace,
}

/// Every attempt at one task on one target.
#[derive(Debug, Clone, Serialize)]
pub struct TaskReport {
    pub task: String,
    pub target: String,
    pub attempts: Vec<Attempt>,
}

impl TaskReport {
    pub fn passed(&self) -> usize {
        self.attempts.iter().filter(|a| a.ok).count()
    }

    pub fn pass_rate(&self) -> f64 {
        if self.attempts.is_empty() {
            return 0.0;
        }
        self.passed() as f64 / self.attempts.len() as f64
    }

    /// Total spend across attempts, `None` if no attempt had a price.
    pub fn cost(&self) -> Option<f64> {
        let costs: Vec<f64> = self.attempts.iter().filter_map(|a| a.cost).collect();
        (!costs.is_empty()).then(|| costs.iter().sum())
    }

    /// Median elapsed time, which is the honest middle for a handful of runs:
    /// one retried request would drag a mean somewhere no attempt went.
    pub fn median_ms(&self) -> u64 {
        let mut times: Vec<u64> = self.attempts.iter().map(|a| a.elapsed_ms).collect();
        if times.is_empty() {
            return 0;
        }
        times.sort_unstable();
        times[times.len() / 2]
    }
}

/// Run one task `runs` times, building a fresh `Chat` and workspace each time.
///
/// `build` is handed the workspace so it can root the file tools there. It is
/// called per attempt rather than once, because a `Chat` carries a system
/// prompt built around a specific directory and reusing one across attempts
/// would point every run at the first attempt's files.
pub async fn run_task<F>(task: &Task, target: &str, runs: usize, mut build: F) -> TaskReport
where
    F: FnMut(&Path) -> Result<Chat, String>,
{
    let mut attempts = Vec::new();
    for i in 0..runs {
        attempts.push(attempt(task, i, &mut build).await);
    }
    TaskReport {
        task: task.name.to_string(),
        target: target.to_string(),
        attempts,
    }
}

async fn attempt<F>(task: &Task, index: usize, build: &mut F) -> Attempt
where
    F: FnMut(&Path) -> Result<Chat, String>,
{
    let failed = |msg: String| Attempt {
        ok: false,
        failure: Some(msg),
        rounds: 0,
        tool_calls: 0,
        denied_calls: 0,
        hit_round_limit: false,
        input_tokens: 0,
        output_tokens: 0,
        cost: None,
        elapsed_ms: 0,
        trace: Trace::default(),
    };

    let workspace = match Workspace::lay_out(task, index) {
        Ok(w) => w,
        Err(e) => return failed(format!("could not set up the workspace: {e}")),
    };
    let chat = match build(workspace.path()) {
        Ok(c) => c,
        Err(e) => return failed(format!("could not build a chat: {e}")),
    };

    let mut session = Session::new();
    let cancel = CancellationToken::new();
    let (mut rounds, mut tool_calls, mut denied_calls) = (0, 0, 0);
    let mut hit_round_limit = false;
    let mut trace = Trace::default();
    let mut this_round: Vec<Call> = Vec::new();
    let started = Instant::now();
    let outcome = {
        let mut on_event = |e: TurnEvent| match e {
            TurnEvent::ToolCall { name, input, .. } => {
                tool_calls += 1;
                this_round.push(Call {
                    name,
                    input: truncate(&input.to_string()),
                });
            }
            TurnEvent::ToolDenied { .. } => denied_calls += 1,
            TurnEvent::RoundLimit { .. } => hit_round_limit = true,
            // One `Usage` per round is the engine's contract, which makes it
            // the round counter — and the round *boundary*, since it arrives
            // after the stream has finished and before any tool runs.
            TurnEvent::Usage { .. } => {
                rounds += 1;
                trace.rounds.push(std::mem::take(&mut this_round));
            }
            _ => {}
        };
        chat.run_turn(&mut session, task.instruction, &cancel, &mut on_event)
            .await
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;

    if let Err(e) = outcome {
        let mut a = failed(format!("turn failed: {e}"));
        a.elapsed_ms = elapsed_ms;
        return a;
    }

    let usage = session.total_usage();
    let final_text = last_assistant_text(&session);
    // The check reads the workspace as the model left it. Nothing is cleaned
    // up before it runs, and the temp directory only goes away with the guard.
    let verdict = (task.check)(&Outcome {
        dir: workspace.path(),
        answer: &final_text,
        trace: &trace,
    });
    Attempt {
        ok: verdict.is_ok(),
        failure: verdict.err().map(|why| {
            // Say which kind of failure it was. A wrong answer sends someone
            // to the model, an exhausted round limit sends them to
            // `max_rounds`, and a reply with no text at all sends them to the
            // adapter — and all three read identically as an empty string in
            // the check's own message.
            if hit_round_limit {
                format!("{why} (stopped at the round limit, still working)")
            } else if final_text.trim().is_empty() {
                format!("{why} (the turn ended with no final message)")
            } else {
                why
            }
        }),
        rounds,
        tool_calls,
        denied_calls,
        hit_round_limit,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost: {
            let c = session.cost();
            c.is_complete().then_some(c.usd)
        },
        elapsed_ms,
        trace,
    }
}

fn truncate(s: &str) -> String {
    match s.char_indices().nth(CALL_INPUT) {
        Some((cut, _)) => format!("{}…", &s[..cut]),
        None => s.to_string(),
    }
}

fn last_assistant_text(session: &Session) -> String {
    session
        .messages()
        .iter()
        .rev()
        .find(|m| m.role == nightloom_core::Role::Assistant)
        .map(|m| m.text())
        .unwrap_or_default()
}

/// A throwaway directory holding one attempt's files.
///
/// Per attempt, not per task: attempts have to be independent or the second
/// one starts from the first one's edits and measures something else entirely.
struct Workspace(PathBuf);

impl Workspace {
    fn lay_out(task: &Task, index: usize) -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-eval-{}-{}-{}-{index}",
            task.name,
            std::process::id(),
            now_nanos()
        ));
        std::fs::create_dir_all(&dir)?;
        for (rel, contents) in task.files {
            let path = dir.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, contents)?;
        }
        Ok(Self(dir))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASK: Task = Task {
        name: "fixture",
        instruction: "unused",
        files: &[("a/b.txt", "hello"), ("top.txt", "world")],
        check: |_| Ok(()),
    };

    #[test]
    fn a_workspace_lays_out_nested_fixture_files() {
        let w = Workspace::lay_out(&TASK, 0).unwrap();
        assert_eq!(
            std::fs::read_to_string(w.path().join("a/b.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(w.path().join("top.txt")).unwrap(),
            "world"
        );
    }

    #[test]
    fn each_attempt_gets_its_own_directory() {
        let a = Workspace::lay_out(&TASK, 0).unwrap();
        let b = Workspace::lay_out(&TASK, 1).unwrap();
        assert_ne!(a.path(), b.path());
        // One attempt's edits must not be visible to the next, or the second
        // run measures the first run's leftovers.
        std::fs::write(a.path().join("top.txt"), "edited").unwrap();
        assert_eq!(
            std::fs::read_to_string(b.path().join("top.txt")).unwrap(),
            "world"
        );
    }

    #[test]
    fn a_workspace_is_removed_when_dropped() {
        let path = {
            let w = Workspace::lay_out(&TASK, 0).unwrap();
            w.path().to_path_buf()
        };
        assert!(!path.exists());
    }

    #[test]
    fn pass_rate_and_median_summarize_repeated_attempts() {
        let attempt = |ok: bool, ms: u64| Attempt {
            ok,
            failure: None,
            rounds: 1,
            tool_calls: 0,
            denied_calls: 0,
            hit_round_limit: false,
            input_tokens: 0,
            output_tokens: 0,
            cost: Some(0.5),
            elapsed_ms: ms,
            trace: Trace::default(),
        };
        let report = TaskReport {
            task: "t".into(),
            target: "x".into(),
            attempts: vec![attempt(true, 300), attempt(false, 100), attempt(true, 9000)],
        };
        assert_eq!(report.passed(), 2);
        assert!((report.pass_rate() - 2.0 / 3.0).abs() < 1e-12);
        // The 9s outlier does not move the middle, which is the point of
        // reporting a median for a handful of sampled runs.
        assert_eq!(report.median_ms(), 300);
        assert_eq!(report.cost(), Some(1.5));
    }

    #[test]
    fn an_unpriced_run_reports_no_cost_rather_than_zero() {
        let report = TaskReport {
            task: "t".into(),
            target: "x".into(),
            attempts: vec![Attempt {
                ok: true,
                failure: None,
                rounds: 1,
                tool_calls: 0,
                denied_calls: 0,
                hit_round_limit: false,
                input_tokens: 0,
                output_tokens: 0,
                cost: None,
                elapsed_ms: 1,
                trace: Trace::default(),
            }],
        };
        assert_eq!(report.cost(), None);
    }
}
