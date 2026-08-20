use crate::message::ContentBlock;
use crate::provider::ToolDef;
use crate::session::SessionEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Re-exported so an implementor can name the type [`Tool::call`] takes
/// without adding a dependency of its own. The contract lives here; the
/// primitive is `tokio-util`'s.
pub use tokio_util::sync::CancellationToken;

/// What running a tool can do outside the conversation — the axis an
/// approval policy sorts on, so that a shell can wave through the tools that
/// only look and stop on the ones that act.
///
/// Serializable because a GUI shell has to carry this across an IPC boundary
/// to whatever renders the prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    /// Observes only: reading a file, searching, the clock. Nothing outside
    /// the conversation changes.
    ReadOnly,
    /// Writes to the conversation itself and nothing else — the task list.
    Session,
    /// Can change the world: files, processes, the network.
    Mutating,
}

/// A tool held behind a shared pointer is still a tool.
///
/// This is what lets one connection be *shared* rather than duplicated. A
/// `Chat` owns `Box<dyn Tool>`, so without this every subagent would need its
/// own copy of every tool — which is harmless for a built-in that owns
/// nothing, and quite wrong for one holding a live connection to another
/// process: spawning a second copy of every MCP server per subagent would be
/// the obvious way to do it and the wrong one.
#[async_trait::async_trait]
impl<T: Tool + ?Sized> Tool for std::sync::Arc<T> {
    fn def(&self) -> ToolDef {
        (**self).def()
    }

    async fn call(&self, input: Value, cancel: &CancellationToken) -> Result<String, String> {
        (**self).call(input, cancel).await
    }

    fn effect(&self) -> Effect {
        (**self).effect()
    }

    fn drain_events(&self) -> Vec<SessionEvent> {
        (**self).drain_events()
    }
}

/// An executable tool. Implementations live wherever the capability lives
/// (CLI built-ins, eval fixtures, eventually MCP clients); core only defines
/// the contract.
#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn def(&self) -> ToolDef;

    /// Execute the call. `Err` becomes a `ToolResult` with `is_error: true`
    /// and is fed back to the model rather than aborting the turn — the
    /// model gets to see and react to tool failures.
    ///
    /// `cancel` is the turn's token, and it is an *asking*, not an enforced
    /// deadline. The engine does not abandon a call it cannot cancel, and
    /// that restraint is the whole reason the token has to be a parameter:
    /// dropping the future would leave a `tool_use` with no `tool_result`,
    /// which is invalid on replay against every provider — the failure
    /// [`orphan_marker`](crate::session::orphan_marker) exists to repair
    /// after a crash and should not be manufactured on purpose here. So a
    /// cancelled turn still gets a result for every call it started, and a
    /// tool that wants Ctrl-C to mean something has to return one.
    ///
    /// Honour it if there is anything to honour: a child process to kill, a
    /// request in flight, a directory walk part way through. Most tools
    /// finish in microseconds and correctly ignore it. Returning `Err` on
    /// cancellation is right — nothing was produced, and the model is
    /// reading the result of a turn the user has already interrupted.
    async fn call(&self, input: Value, cancel: &CancellationToken) -> Result<String, String>;

    /// What running this tool can do outside the conversation.
    ///
    /// The default is [`Effect::Mutating`] on purpose: a tool that has not
    /// answered this question — one arriving over MCP, a third-party
    /// implementation compiled against an older version of this trait — is
    /// something nobody has vouched for, and the safe reading of silence is
    /// "this can do anything". A `ReadOnly` default would make every future
    /// tool bypass the approval gate by omission, which is the failure that
    /// cannot be noticed until after it has happened.
    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    /// Session state this tool produced since the last drain, to be appended
    /// to the log by the turn engine. Almost every tool returns nothing; the
    /// exceptions are tools whose output *is* conversation state rather than
    /// a result to read once — the task list, for instance.
    ///
    /// This is how a tool writes to the log without the `Tool` contract
    /// having to hand out a `&mut Session` it could corrupt.
    fn drain_events(&self) -> Vec<SessionEvent> {
        Vec::new()
    }
}

/// The most one tool result may put on the wire.
///
/// A backstop, not a replacement for a tool truncating its own output. A
/// tool that knows what it cut can say something useful about it — `grep`
/// reports how many files matched and tells the model to narrow the pattern
/// — and every built-in does exactly that, well under this ceiling. This is
/// for the tools that never considered the question: one arriving over MCP,
/// whose output is whatever another process decided to return, or a
/// third-party implementation compiled against this trait. That is the same
/// population [`Tool::effect`] defaults to `Mutating` for, and the argument
/// is the same one — the safe reading of silence is that nobody vouched for
/// this, and a limit applied per tool is one every future tool can escape by
/// omission.
///
/// Four times the 16 KiB the built-ins cap at, deliberately. A ceiling low
/// enough to pre-empt a tool that *did* think about its own size would
/// replace a shaped truncation with a blunt one, which is the wrong trade in
/// the only cases where the shaped one exists. Roughly 16k tokens: a large
/// but legitimate result still arrives whole, and no single call can spend a
/// context window it does not own.
pub const RESULT_LIMIT: usize = 64 * 1024;

/// Find a tool by name and execute one call, producing the result block to
/// send back. An unknown tool name is itself an error result: the model
/// hallucinated a tool, and should be told so.
pub async fn run_tool(
    tools: &[Box<dyn Tool>],
    id: &str,
    name: &str,
    input: Value,
    cancel: &CancellationToken,
) -> ContentBlock {
    let outcome = match tools.iter().find(|t| t.def().name == name) {
        Some(tool) => tool.call(input, cancel).await,
        None => Err(format!("unknown tool: {name}")),
    };
    let (content, is_error) = match outcome {
        Ok(content) => (capped(content), false),
        Err(message) => (capped(message), true),
    };
    ContentBlock::ToolResult {
        tool_use_id: id.to_string(),
        name: name.to_string(),
        content,
        is_error,
    }
}

/// The declared effect of the named tool, or `None` if no such tool is
/// registered. A name that resolves to nothing is not a decision an approval
/// policy should be asked about — [`run_tool`] turns it into an error result
/// for the model, and no user action can make a hallucinated tool exist.
pub fn effect_of(tools: &[Box<dyn Tool>], name: &str) -> Option<Effect> {
    tools
        .iter()
        .find(|t| t.def().name == name)
        .map(|t| t.effect())
}

pub fn defs(tools: &[Box<dyn Tool>]) -> Vec<ToolDef> {
    tools.iter().map(|t| t.def()).collect()
}

/// Cut an oversized result down to [`RESULT_LIMIT`], saying so.
///
/// The notice is addressed to the model, like every other string a tool
/// sends back: a result that stops early without saying it stopped reads as
/// a file that ended there, and the model acts on it as if it were whole.
/// Naming the full size is what turns "this is all of it" into "ask for a
/// smaller part of it".
///
/// Applied to failures too. An `is_error` result is a block on the wire like
/// any other, and a server that fails with a megabyte of JSON at it is not a
/// hypothetical.
fn capped(text: String) -> String {
    if text.len() <= RESULT_LIMIT {
        return text;
    }
    let mut cut = RESULT_LIMIT;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let total = text.len();
    format!(
        "{}\n… (tool result truncated: {cut} of {total} bytes. Ask for a smaller part of it.)",
        &text[..cut]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `futures` is already a dependency and a runtime is not: core has no
    /// async tests otherwise, and adding tokio for four of them would put a
    /// runtime in the one crate that deliberately has none.
    fn run<F: std::future::Future>(f: F) -> F::Output {
        futures::executor::block_on(f)
    }

    struct Fixed(Result<String, String>);

    #[async_trait::async_trait]
    impl Tool for Fixed {
        fn def(&self) -> ToolDef {
            ToolDef {
                name: "fixed".into(),
                description: String::new(),
                input_schema: Value::Null,
            }
        }

        async fn call(&self, _input: Value, _cancel: &CancellationToken) -> Result<String, String> {
            self.0.clone()
        }
    }

    fn call(outcome: Result<String, String>) -> (String, bool) {
        let tools: Vec<Box<dyn Tool>> = vec![Box::new(Fixed(outcome))];
        match run(run_tool(
            &tools,
            "c1",
            "fixed",
            Value::Null,
            &CancellationToken::new(),
        )) {
            ContentBlock::ToolResult {
                content, is_error, ..
            } => (content, is_error),
            other => panic!("not a tool result: {other:?}"),
        }
    }

    #[test]
    fn a_result_within_the_limit_is_untouched() {
        let text = "x".repeat(RESULT_LIMIT);
        let (content, is_error) = call(Ok(text.clone()));
        assert_eq!(content, text, "a result exactly at the limit is not cut");
        assert!(!is_error);
    }

    #[test]
    fn an_oversized_result_is_cut_and_says_it_was() {
        let total = RESULT_LIMIT + 5_000;
        let (content, is_error) = call(Ok("x".repeat(total)));
        assert!(!is_error, "truncation is not a failure of the call");
        assert!(
            content.len() < total,
            "the result was not cut: {} bytes",
            content.len()
        );
        // The model has to be able to tell a cut result from a short one,
        // and to know what to ask for instead.
        assert!(
            content.contains("truncated"),
            "no notice on a cut result: {}",
            &content[content.len() - 200..]
        );
        assert!(
            content.contains(&total.to_string()),
            "the notice does not name the full size"
        );
    }

    #[test]
    fn the_cut_lands_on_a_character_boundary() {
        // Three bytes each, so RESULT_LIMIT (65536) falls inside one.
        let (content, _) = call(Ok("界".repeat(30_000)));
        let body = content
            .split('\n')
            .next()
            .expect("a body before the notice");
        assert!(body.chars().all(|c| c == '界'), "the cut split a character");
        assert_eq!(body.len() % 3, 0, "the cut is not on a boundary");
        assert!(body.len() <= RESULT_LIMIT);
        assert!(
            body.len() > RESULT_LIMIT - 3,
            "cut back further than needed"
        );
    }

    /// The contract [`Tool::call`] documents, pinned: cancelling does not
    /// let the engine skip a call it has already announced. A `tool_use`
    /// with no matching `tool_result` is invalid on replay against every
    /// provider, so an interrupted turn still owes the log a result — and
    /// the token is a parameter precisely so a tool can supply one rather
    /// than be dropped.
    #[test]
    fn a_cancelled_call_still_produces_a_result_block() {
        let tools: Vec<Box<dyn Tool>> = vec![Box::new(Fixed(Err("interrupted".into())))];
        let cancel = CancellationToken::new();
        cancel.cancel();
        match run(run_tool(&tools, "c1", "fixed", Value::Null, &cancel)) {
            ContentBlock::ToolResult {
                tool_use_id,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id, "c1", "the result must answer the call by id");
                assert!(is_error);
            }
            other => panic!("not a tool result: {other:?}"),
        }
    }

    #[test]
    fn a_failure_is_capped_like_a_success() {
        // A server that fails with a megabyte of JSON attached is not a
        // hypothetical, and an error result is a block on the wire like any
        // other.
        let (content, is_error) = call(Err("e".repeat(RESULT_LIMIT + 1)));
        assert!(is_error, "still an error");
        assert!(content.contains("truncated"));
        assert!(content.len() < RESULT_LIMIT + 1_000);
    }

    #[test]
    fn a_hallucinated_tool_is_an_error_result_not_an_abort() {
        let tools: Vec<Box<dyn Tool>> = vec![Box::new(Fixed(Ok("never runs".into())))];
        match run(run_tool(
            &tools,
            "c1",
            "no_such_tool",
            Value::Null,
            &CancellationToken::new(),
        )) {
            ContentBlock::ToolResult {
                content,
                is_error,
                tool_use_id,
                ..
            } => {
                assert!(is_error);
                assert!(content.contains("no_such_tool"), "{content}");
                assert_eq!(tool_use_id, "c1", "the call it answers");
            }
            other => panic!("not a tool result: {other:?}"),
        }
    }
}
