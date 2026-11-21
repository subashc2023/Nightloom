//! The runaway guard for unattended runs (nightshift item 784).
//!
//! His words: "when the same command is ran three times, then it sends …
//! to ask me". Refined with him: a run pauses when **the same tool call
//! returns the same result three times in a row** — a poll whose output
//! changes is not stuck — or when a job's run makes far more tool calls
//! than its own runs usually do (a first run has a generous fixed
//! ceiling). The pause stops the spending, his phone gets a push with the
//! command, and the chat shows a card with Continue and Stop.
//!
//! - **What is watched** ([`Guard::see`]): every `ToolCall` and its
//!   `ToolResult` (or `ToolDenied`) of the turn, the main thread's and each
//!   subagent's apart ([`TurnEvent::Subagent`] by its spawning call). The
//!   same call is the same tool with the same input, exactly; the same
//!   result is the same text and the same error flag. Anything else in
//!   between — another call, a changed output — starts the count again.
//! - **When it applies**: only when nobody is watching — a job's run, a
//!   Mac he has left, an away server with no phone connected
//!   ([`crate::agent_turn::TurnEnv::unattended`], asked at the moment the
//!   guard trips, so a run he comes back to is not paused under him).
//! - **The pause** (in `agent_turn`): the guard trips on the third result,
//!   the CLI is interrupted the way Stop interrupts it (measured clean in
//!   item 074: the CLI closes the turn in its session), and the turn waits
//!   on a card named [`STUCK_TOOL`] through the same approval channel as a
//!   deferred call — so the phone's card and push come for free.
//!   **Continue** resumes the same CLI session with [`continue_note`];
//!   the guard then needs twice as many repeats (and twice the calls)
//!   before it pauses again, so a poll he let run is not stopped every
//!   third look. **Stop** ends the run with everything it did on the log
//!   and one line saying why ([`stopped_line`]).
//! - **Refusals with nobody there** (item 788): when the repeated result
//!   is a refusal — a call set aside because nobody can approve it, a
//!   tool the chat does not allow, the CLI's own denial ([`is_refusal`])
//!   — and nobody can press the card either, the run does not wait on it:
//!   it ends at once with its record and [`ended_line`], so a job is not
//!   left "running" until its six-hour mark. A watched run keeps the card.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use crate::turn::TurnEvent;

/// The same call with the same result this many times in a row pauses a run.
pub const REPEATS: u32 = 3;
/// A job's first runs (fewer than [`USUAL_MIN_RUNS`] recorded): the tool
/// calls a run may make before it pauses.
pub const FIRST_RUN_CALLS: u32 = 200;
/// A job with a history pauses past this many times its largest recent run…
pub const USUAL_TIMES: u32 = 3;
/// … but never below this many calls.
pub const USUAL_FLOOR: u32 = 60;
/// Runs a job needs on record before its own usual is the measure.
pub const USUAL_MIN_RUNS: usize = 2;
/// Recent runs a job keeps the call count of.
pub const USUAL_KEEP: usize = 5;
/// The card's name on the approval channel: not a tool the CLI knows.
pub const STUCK_TOOL: &str = "nightloom_stuck";
/// How much of a command the card and the push show.
const SHOWN_MAX: usize = 60;
/// How much of the repeated result the card shows.
const RESULT_MAX: usize = 400;
/// The line the log keeps when he chose Stop; the jobs list reads a reply
/// that starts with it as a stopped run.
pub const STOPPED_PREFIX: &str = "Stopped — ";

/// A job's ceiling for one run's tool calls: [`FIRST_RUN_CALLS`] until it
/// has [`USUAL_MIN_RUNS`] runs on record, then [`USUAL_TIMES`] times its
/// largest recent run, at least [`USUAL_FLOOR`]. Pure.
pub fn ceiling_for(recent: &[u32]) -> (u32, Option<u32>) {
    if recent.len() < USUAL_MIN_RUNS {
        return (FIRST_RUN_CALLS, None);
    }
    let usual = recent.iter().copied().max().unwrap_or(0);
    ((usual * USUAL_TIMES).max(USUAL_FLOOR), Some(usual))
}

/// What a turn is watched against: the job it runs for, when it does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobUsual {
    /// The job's name, as the push and the card say it.
    pub title: String,
    /// Tool calls of its recent runs, oldest first.
    pub recent_calls: Vec<u32>,
}

/// Why a run paused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "why", rename_all = "snake_case")]
pub enum Trip {
    /// The same call returned the same result `count` times in a row.
    Repeat {
        tool: String,
        /// The call as the card and the push show it (a command, a path).
        shown: String,
        count: u32,
        /// The repeated result's opening.
        result: String,
        /// The result was an error.
        error: bool,
        /// The repeated result was a refusal ([`is_refusal`], item 788):
        /// the call never ran, so waiting changes nothing.
        refused: bool,
    },
    /// A job's run made `made` tool calls; it pauses past `ceiling`.
    Calls {
        made: u32,
        ceiling: u32,
        /// Its runs' usual, when it has a history.
        usual: Option<u32>,
    },
}

impl Trip {
    /// The push's line and the card's head: "Looks stuck: ran `cargo
    /// test` 3 times, same result".
    pub fn sentence(&self) -> String {
        match self {
            Trip::Repeat { shown, count, .. } => {
                format!("Looks stuck: ran `{shown}` {count} times, same result")
            }
            Trip::Calls { made, usual, .. } => match usual {
                Some(u) => format!("Looks stuck: {made} tool calls, its runs usually take {u}"),
                None => format!("Looks stuck: {made} tool calls in one run"),
            },
        }
    }

    /// The card's input: the trip's fields and its sentence.
    pub fn card_input(&self, job: Option<&str>) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Value::Object(o) = &mut v {
            o.insert("sentence".into(), Value::String(self.sentence()));
            if let Some(j) = job {
                o.insert("job".into(), Value::String(j.to_string()));
            }
        }
        v
    }
}

impl Trip {
    /// The same call was refused each time (item 788).
    pub fn refused(&self) -> bool {
        matches!(self, Trip::Repeat { refused: true, .. })
    }
}

/// Refusals Nightloom itself gives a call (item 788), by their reasons.
fn own_refusals() -> [&'static str; 7] {
    [
        crate::agent::ask::UNATTENDED_REASON,
        crate::agent::ask::LATER_REASON,
        crate::agent::ask::AUTO_LATER_REASON,
        crate::agent::CHAT_POLICY_REASON,
        crate::agent::PREVIEW_UNDER_CHAT_POLICY_REASON,
        crate::agent::BROWSER_UNDER_CHAT_POLICY_REASON,
        crate::agent::connector_writes::REASON,
    ]
}

/// The CLI's own words when a permission mode or rule refuses a call.
const CLI_REFUSALS: [&str; 2] = ["haven't granted it yet", "has been denied"];

/// A tool result that says the call was refused, not run (item 788):
/// one of Nightloom's own reasons, or the CLI's denial. Pure.
pub fn is_refusal(content: &str) -> bool {
    own_refusals().iter().any(|r| content.contains(r))
        || CLI_REFUSALS.iter().any(|r| content.contains(r))
}

/// What the resumed run reads when he chose Continue.
pub fn continue_note(trip: &Trip) -> String {
    let why = match trip {
        Trip::Repeat { shown, count, .. } => {
            format!("`{shown}` returned the same result {count} times in a row")
        }
        Trip::Calls { made, .. } => format!("the run had made {made} tool calls"),
    };
    format!(
        "[Nightloom paused this run because {why}, and Swaraag chose Continue.] Carry on with \
         the task. If you are waiting on something that has not changed, wait longer between \
         checks; if something keeps failing the same way, try another way or end the turn and \
         say what is blocking."
    )
}

/// The line the log keeps when he chose Stop.
pub fn stopped_line(trip: &Trip) -> String {
    let why = match trip {
        Trip::Repeat { shown, count, .. } => {
            format!("it ran `{shown}` {count} times in a row with the same result")
        }
        Trip::Calls { made, .. } => format!("it had made {made} tool calls"),
    };
    format!("{STOPPED_PREFIX}{why}, and you chose Stop. Everything it did is above.")
}

/// The line the log keeps when a refused call repeated with nobody there
/// to answer (item 788): the run ended instead of waiting on a card.
/// Starts with [`STOPPED_PREFIX`], so the jobs list reads a stopped run.
pub fn ended_line(trip: &Trip) -> String {
    let what = match trip {
        Trip::Repeat { shown, count, .. } => {
            format!("`{shown}` was refused {count} times in a row")
        }
        Trip::Calls { made, .. } => format!("it had made {made} tool calls"),
    };
    format!(
        "{STOPPED_PREFIX}{what} and nobody was there to answer, so the run ended here \
         instead of waiting. Everything it did is above."
    )
}

/// The call as a person reads it: a shell command as typed, a file by its
/// path, else the tool's name with its first short text argument. Cut to
/// [`SHOWN_MAX`].
pub fn shown(name: &str, input: &Value) -> String {
    let pick = |k: &str| input.get(k).and_then(Value::as_str).map(str::trim);
    let text = match pick("command") {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => {
            let arg = ["file_path", "path", "url", "pattern", "query"]
                .iter()
                .find_map(|k| pick(k).filter(|s| !s.is_empty()));
            match arg {
                Some(a) => format!("{name} {a}"),
                None => name.to_string(),
            }
        }
    };
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    cut(&flat, SHOWN_MAX)
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// One thread's run of identical calls.
#[derive(Debug, Default)]
struct Thread {
    /// The last call's key and its result.
    last: Option<(String, String, bool)>,
    streak: u32,
}

/// The guard over one turn. Feed it every event ([`Guard::see`]); it says
/// when the run should pause.
#[derive(Debug)]
pub struct Guard {
    threads: HashMap<String, Thread>,
    /// Calls announced and not yet answered: id → (thread, key, name, input).
    pending: HashMap<String, (String, String, String, Value)>,
    calls: u32,
    repeats: u32,
    ceiling: Option<u32>,
    usual: Option<u32>,
    /// The calls ceiling already tripped at this count (one pause each).
    calls_tripped: bool,
}

impl Guard {
    /// A guard for a run; `job` gives a job's calls ceiling.
    pub fn new(job: Option<&JobUsual>) -> Self {
        let (ceiling, usual) = match job {
            Some(j) => {
                let (c, u) = ceiling_for(&j.recent_calls);
                (Some(c), u)
            }
            None => (None, None),
        };
        Self {
            threads: HashMap::new(),
            pending: HashMap::new(),
            calls: 0,
            repeats: REPEATS,
            ceiling,
            usual,
            calls_tripped: false,
        }
    }

    /// Tool calls seen so far, every thread's.
    pub fn calls(&self) -> u32 {
        self.calls
    }

    /// One event of the turn; a [`Trip`] when this event makes the run look
    /// stuck.
    pub fn see(&mut self, e: &TurnEvent) -> Option<Trip> {
        self.see_in(String::new(), e)
    }

    fn see_in(&mut self, thread: String, e: &TurnEvent) -> Option<Trip> {
        match e {
            TurnEvent::Subagent {
                parent_tool_use_id,
                event,
            } => self.see_in(parent_tool_use_id.clone(), event),
            TurnEvent::ToolCall { id, name, input } => {
                self.calls += 1;
                let key = format!("{name}\u{0}{input}");
                self.pending
                    .insert(id.clone(), (thread, key, name.clone(), input.clone()));
                match self.ceiling {
                    Some(c) if self.calls > c && !self.calls_tripped => {
                        self.calls_tripped = true;
                        Some(Trip::Calls {
                            made: self.calls,
                            ceiling: c,
                            usual: self.usual,
                        })
                    }
                    _ => None,
                }
            }
            TurnEvent::ToolResult {
                tool_use_id,
                content,
                is_error,
                ..
            } => self.answered(
                tool_use_id,
                content,
                *is_error,
                *is_error && is_refusal(content),
            ),
            TurnEvent::ToolDenied {
                tool_use_id,
                reason,
                ..
            } => self.answered(tool_use_id, reason, true, true),
            _ => None,
        }
    }

    fn answered(&mut self, id: &str, content: &str, error: bool, refused: bool) -> Option<Trip> {
        let (thread, key, name, input) = self.pending.remove(id)?;
        let t = self.threads.entry(thread).or_default();
        let same = t
            .last
            .as_ref()
            .is_some_and(|(k, c, err)| *k == key && c == content && *err == error);
        if same {
            t.streak += 1;
        } else {
            t.last = Some((key, content.to_string(), error));
            t.streak = 1;
        }
        (t.streak >= self.repeats).then(|| {
            t.streak = 0;
            Trip::Repeat {
                tool: name.clone(),
                shown: shown(&name, &input),
                count: self.repeats,
                result: cut(content.trim(), RESULT_MAX),
                error,
                refused,
            }
        })
    }

    /// He chose Continue: twice the repeats and twice the calls before the
    /// next pause, and every count starts again.
    pub fn continued(&mut self) {
        self.repeats = self.repeats.saturating_mul(2);
        self.threads.clear();
        if let Some(c) = self.ceiling {
            self.ceiling = Some(c.saturating_mul(2).max(self.calls + 1));
            self.calls_tripped = false;
        }
    }

    /// The guard did not apply (somebody was watching): the count starts
    /// again, so it asks once per three, not on every later repeat.
    pub fn passed(&mut self) {
        self.calls_tripped = false;
        if let Some(c) = self.ceiling {
            self.ceiling = Some(c.max(self.calls) + c);
        }
    }
}

/// The tool calls of the run that answered `text` in a chat's log (the
/// log's JSON, as [`crate::jobs::reply_in`] reads it): `tool_use` blocks of
/// the assistant messages after the last time `text` was sent. Pure.
pub fn calls_in(events: &[Value], text: &str) -> Option<u32> {
    let sent = events.iter().rposition(|e| {
        e["event"] == "user_message" && e["text"].as_str().is_some_and(|t| t.contains(text.trim()))
    })?;
    let n = events[sent + 1..]
        .iter()
        .filter(|e| e["event"] == "assistant_message")
        .filter_map(|e| e["blocks"].as_array())
        .flatten()
        .filter(|b| b["type"] == "tool_use")
        .count();
    Some(u32::try_from(n).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(id: &str, cmd: &str) -> TurnEvent {
        TurnEvent::ToolCall {
            id: id.into(),
            name: "Bash".into(),
            input: json!({ "command": cmd }),
        }
    }

    fn result(id: &str, out: &str, err: bool) -> TurnEvent {
        TurnEvent::ToolResult {
            tool_use_id: id.into(),
            name: "Bash".into(),
            content: out.into(),
            is_error: err,
        }
    }

    /// A run looping on one failing command trips on the third identical
    /// result, and says what it ran.
    #[test]
    fn the_third_identical_failure_trips() {
        let mut g = Guard::new(None);
        for i in 0..2 {
            let id = format!("t{i}");
            assert_eq!(g.see(&call(&id, "cargo test")), None);
            assert_eq!(g.see(&result(&id, "error[E0425]", true)), None);
        }
        assert_eq!(g.see(&call("t2", "cargo test")), None);
        let trip = g.see(&result("t2", "error[E0425]", true)).expect("tripped");
        assert_eq!(
            trip,
            Trip::Repeat {
                tool: "Bash".into(),
                shown: "cargo test".into(),
                count: 3,
                result: "error[E0425]".into(),
                error: true,
                refused: false,
            }
        );
        assert!(!trip.refused());
        assert_eq!(
            trip.sentence(),
            "Looks stuck: ran `cargo test` 3 times, same result"
        );
    }

    /// A poll whose output changes never trips, however long it runs.
    #[test]
    fn a_poll_whose_output_changes_is_not_stuck() {
        let mut g = Guard::new(None);
        for i in 0..20 {
            let id = format!("p{i}");
            assert_eq!(g.see(&call(&id, "gh run view")), None);
            assert_eq!(g.see(&result(&id, &format!("{i} of 20 done"), false)), None);
        }
    }

    /// Another call in between, or the same command failing differently,
    /// starts the count again.
    #[test]
    fn anything_in_between_starts_again() {
        let mut g = Guard::new(None);
        let seq = [
            ("a", "make", "fail"),
            ("b", "make", "fail"),
            ("c", "ls", "x"),
            ("d", "make", "fail"),
            ("e", "make", "fail other"),
            ("f", "make", "fail"),
        ];
        for (id, cmd, out) in seq {
            g.see(&call(id, cmd));
            assert_eq!(g.see(&result(id, out, true)), None, "{id}");
        }
    }

    /// The main thread and a subagent are counted apart: two helpers each
    /// running a command twice is not one loop of four.
    #[test]
    fn threads_are_counted_apart() {
        let mut g = Guard::new(None);
        let sub = |e: TurnEvent| TurnEvent::Subagent {
            parent_tool_use_id: "agent1".into(),
            event: Box::new(e),
        };
        for i in 0..2 {
            let (m, s) = (format!("m{i}"), format!("s{i}"));
            g.see(&call(&m, "make"));
            assert_eq!(g.see(&result(&m, "fail", true)), None);
            g.see(&sub(call(&s, "make")));
            assert_eq!(g.see(&sub(result(&s, "fail", true))), None);
        }
        g.see(&sub(call("s2", "make")));
        assert!(matches!(
            g.see(&sub(result("s2", "fail", true))),
            Some(Trip::Repeat { .. })
        ));
    }

    /// After Continue the same loop needs six more before it pauses again.
    #[test]
    fn continue_doubles_the_repeats() {
        let mut g = Guard::new(None);
        let mut trips = Vec::new();
        for i in 0..12 {
            let id = format!("t{i}");
            g.see(&call(&id, "curl -s localhost:3000"));
            if g.see(&result(&id, "refused", true)).is_some() {
                trips.push(i);
                if trips.len() == 1 {
                    g.continued();
                }
            }
        }
        assert_eq!(trips, vec![2, 8]);
    }

    /// A job's run: a generous ceiling on its first runs, then three times
    /// its own largest recent run, never below the floor.
    #[test]
    fn a_jobs_calls_ceiling_comes_from_its_own_runs() {
        assert_eq!(ceiling_for(&[]), (FIRST_RUN_CALLS, None));
        assert_eq!(ceiling_for(&[12]), (FIRST_RUN_CALLS, None));
        assert_eq!(ceiling_for(&[12, 40, 30]), (120, Some(40)));
        assert_eq!(ceiling_for(&[3, 5]), (USUAL_FLOOR, Some(5)));
        let job = JobUsual {
            title: "Check CI".into(),
            recent_calls: vec![10, 20],
        };
        let mut g = Guard::new(Some(&job));
        let mut tripped = None;
        for i in 0..70 {
            let id = format!("c{i}");
            if let Some(t) = g.see(&TurnEvent::ToolCall {
                id: id.clone(),
                name: "Read".into(),
                input: json!({ "file_path": format!("/f{i}") }),
            }) {
                tripped = Some((i, t));
                break;
            }
        }
        let (i, t) = tripped.expect("tripped");
        assert_eq!(i, 60, "the 61st call is past a ceiling of 60");
        assert_eq!(
            t.sentence(),
            "Looks stuck: 61 tool calls, its runs usually take 20"
        );
    }

    #[test]
    fn a_call_is_shown_as_a_person_reads_it() {
        assert_eq!(
            shown("Bash", &json!({"command": "  cargo   test\n -p x"})),
            "cargo test -p x"
        );
        assert_eq!(
            shown("Read", &json!({"file_path": "/a/b.rs"})),
            "Read /a/b.rs"
        );
        assert_eq!(shown("TodoWrite", &json!({"todos": []})), "TodoWrite");
        let long = "x".repeat(100);
        assert_eq!(
            shown("Bash", &json!({ "command": long })).chars().count(),
            60
        );
    }

    /// Item 788: a refusal repeated is a refused trip — Nightloom's own
    /// set-aside reason, the CLI's denial, or a denial event — and an
    /// ordinary failure is not.
    #[test]
    fn a_repeated_refusal_is_a_refused_trip() {
        let refusal = format!("Hook denied: {}", crate::agent::ask::UNATTENDED_REASON);
        let mut g = Guard::new(None);
        let mut trip = None;
        for i in 0..3 {
            let id = format!("r{i}");
            g.see(&call(&id, "gmail send"));
            trip = g.see(&result(&id, &refusal, true));
        }
        let trip = trip.expect("tripped");
        assert!(trip.refused());
        assert_eq!(
            ended_line(&trip),
            "Stopped — `gmail send` was refused 3 times in a row and nobody was there to \
             answer, so the run ended here instead of waiting. Everything it did is above."
        );
        assert!(is_refusal(
            "Claude requested permissions to use Bash, but you haven't granted it yet."
        ));
        assert!(!is_refusal("error[E0425]: cannot find value"));
        let mut g = Guard::new(None);
        let mut trip = None;
        for i in 0..3 {
            let id = format!("d{i}");
            g.see(&call(&id, "rm -rf x"));
            trip = g.see(&TurnEvent::ToolDenied {
                tool_use_id: id,
                name: "Bash".into(),
                reason: "no".into(),
            });
        }
        assert!(trip.expect("tripped").refused());
    }

    #[test]
    fn calls_in_counts_the_runs_tool_uses() {
        let events = vec![
            json!({"event": "user_message", "text": "check CI"}),
            json!({"event": "assistant_message", "blocks": [{"type": "tool_use"}, {"type": "text", "text": "x"}]}),
            json!({"event": "user_message", "text": "check CI"}),
            json!({"event": "assistant_message", "blocks": [{"type": "tool_use"}, {"type": "tool_use"}]}),
            json!({"event": "assistant_message", "blocks": [{"type": "tool_use"}, {"type": "text", "text": "done"}]}),
        ];
        assert_eq!(calls_in(&events, "check CI"), Some(3));
        assert_eq!(calls_in(&events, "other"), None);
    }
}
