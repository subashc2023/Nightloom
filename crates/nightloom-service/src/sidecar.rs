//! The per-turn sidecar: what the model needs to know about *now*.
//!
//! Everything here changes turn to turn — the clock, the task list, how full
//! the context window is — which is precisely why none of it may go in the
//! system prompt. Prompt caching keys on an exact prefix match, so a clock in
//! the preamble invalidates the whole cached prefix on every single turn and
//! you pay full input price and full time-to-first-token forever.
//!
//! Instead the sidecar rides at the *tail*, appended to the user's message by
//! [`Session::messages_with_sidecar`], and is never written to the log. Old
//! sessions replay without last week's clock or a task list that has since
//! moved on.

use nightloom_core::{Session, SessionEvent, TodoStatus};

/// One contributor to the sidecar. Returning `None` omits the part entirely
/// — an empty task list should take up no tokens, not print "(none)".
pub trait SidecarPart: Send + Sync {
    fn render(&self, ctx: &SidecarContext<'_>) -> Option<String>;
}

/// What parts get to look at. Deliberately narrow: the session (the source of
/// truth) plus the few facts only the shell knows.
pub struct SidecarContext<'a> {
    pub session: &'a Session,
    pub model: &'a str,
    /// The model's input-token limit, when the shell knows it. Without it the
    /// context gauge reports usage but no percentage — better than guessing a
    /// limit and telling the model something false.
    pub context_limit: Option<u64>,
}

/// The default set: clock, context gauge, task list. Cheap, and each one
/// answers a question models otherwise waste a tool call or a guess on.
pub fn default_parts() -> Vec<Box<dyn SidecarPart>> {
    vec![Box::new(Clock), Box::new(ContextGauge), Box::new(Tasks)]
}

/// Render the parts into one block, or `None` if every part declined.
///
/// The framing matters: the model has to be able to tell this apart from
/// something the user typed, or it will answer the status block instead of
/// the question.
pub fn render(parts: &[Box<dyn SidecarPart>], ctx: &SidecarContext<'_>) -> Option<String> {
    let body: Vec<String> = parts.iter().filter_map(|p| p.render(ctx)).collect();
    if body.is_empty() {
        return None;
    }
    Some(format!(
        "<session-status>\nAttached automatically each turn — the user did not type this. \
         Treat it as background; don't reply to it.\n\n{}\n</session-status>",
        body.join("\n\n")
    ))
}

/// Wall-clock time. The cheapest capability in the whole harness: without it
/// a model either guesses the date or burns a round trip on a clock tool.
pub struct Clock;

impl SidecarPart for Clock {
    fn render(&self, _ctx: &SidecarContext<'_>) -> Option<String> {
        let now = chrono::Local::now();
        Some(format!(
            "time: {}",
            now.format("%Y-%m-%d %H:%M:%S %:z (%a)")
        ))
    }
}

/// How full the context window is.
///
/// Estimated from the last assistant turn's accounting — input tokens plus
/// what the model then produced is very close to what the next request will
/// bill as input. That beats summing every turn's usage, which double-counts
/// the whole prefix on each round.
pub struct ContextGauge;

impl SidecarPart for ContextGauge {
    fn render(&self, ctx: &SidecarContext<'_>) -> Option<String> {
        let usage = ctx.session.events().iter().rev().find_map(|e| match e {
            SessionEvent::AssistantMessage { usage, .. } => Some(*usage),
            _ => None,
        })?;
        let used = usage.input_tokens + usage.output_tokens;
        if used == 0 {
            return None;
        }
        Some(match ctx.context_limit {
            Some(limit) if limit > 0 => format!(
                "context: ~{used} of {limit} tokens ({}%) — compact before you run out",
                (used * 100 / limit).min(100)
            ),
            _ => format!("context: ~{used} tokens used"),
        })
    }
}

/// The task list the model wrote through the todo tool. This is the half of
/// the scratchpad that makes it work: without the read-back the model has no
/// idea what it already planned.
pub struct Tasks;

impl SidecarPart for Tasks {
    fn render(&self, ctx: &SidecarContext<'_>) -> Option<String> {
        let todos = ctx.session.todos();
        if todos.is_empty() {
            return None;
        }
        let lines: Vec<String> = todos
            .iter()
            .map(|t| {
                let mark = match t.status {
                    TodoStatus::Pending => " ",
                    TodoStatus::InProgress => "~",
                    TodoStatus::Completed => "x",
                };
                format!("  [{mark}] {}", t.content)
            })
            .collect();
        Some(format!("tasks:\n{}", lines.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::{ContentBlock, TodoItem, Usage};

    fn ctx<'a>(session: &'a Session, limit: Option<u64>) -> SidecarContext<'a> {
        SidecarContext {
            session,
            model: "test-model",
            context_limit: limit,
        }
    }

    #[test]
    fn parts_that_decline_are_omitted() {
        let session = Session::new();
        // Fresh session: no usage yet and no tasks, so only the clock speaks.
        let out = render(&default_parts(), &ctx(&session, None)).unwrap();
        assert!(out.contains("time: "));
        assert!(!out.contains("context:"));
        assert!(!out.contains("tasks:"));
    }

    #[test]
    fn nothing_renders_when_every_part_declines() {
        let session = Session::new();
        let parts: Vec<Box<dyn SidecarPart>> = vec![Box::new(Tasks)];
        assert!(render(&parts, &ctx(&session, None)).is_none());
    }

    #[test]
    fn gauge_reads_the_last_turn_not_the_running_total() {
        let mut session = Session::new();
        for (input, output) in [(100, 10), (500, 20)] {
            session.record_user("q");
            session.record_assistant(
                "test-model",
                vec![ContentBlock::Text { text: "a".into() }],
                Some("end_turn".into()),
                Usage {
                    input_tokens: input,
                    output_tokens: output,
                    reasoning_tokens: None,
                },
            );
        }
        let out = ContextGauge.render(&ctx(&session, Some(1000))).unwrap();
        // 500 + 20 from the latest turn — not 630 summed across both.
        assert!(out.contains("~520 of 1000 tokens (52%)"), "{out}");
    }

    #[test]
    fn gauge_omits_the_percentage_without_a_known_limit() {
        let mut session = Session::new();
        session.record_user("q");
        session.record_assistant(
            "test-model",
            vec![ContentBlock::Text { text: "a".into() }],
            None,
            Usage {
                input_tokens: 40,
                output_tokens: 2,
                reasoning_tokens: None,
            },
        );
        let out = ContextGauge.render(&ctx(&session, None)).unwrap();
        assert_eq!(out, "context: ~42 tokens used");
    }

    #[test]
    fn tasks_render_with_status_marks() {
        let mut session = Session::new();
        session.record_todos(vec![
            TodoItem::new("done thing", TodoStatus::Completed),
            TodoItem::new("doing thing", TodoStatus::InProgress),
            TodoItem::new("later thing", TodoStatus::Pending),
        ]);
        let out = Tasks.render(&ctx(&session, None)).unwrap();
        assert_eq!(
            out,
            "tasks:\n  [x] done thing\n  [~] doing thing\n  [ ] later thing"
        );
    }
}
