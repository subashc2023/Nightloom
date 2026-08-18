use crate::message::ContentBlock;
use crate::provider::ToolDef;
use crate::session::SessionEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// An executable tool. Implementations live wherever the capability lives
/// (CLI built-ins, eval fixtures, eventually MCP clients); core only defines
/// the contract.
#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn def(&self) -> ToolDef;

    /// Execute the call. `Err` becomes a `ToolResult` with `is_error: true`
    /// and is fed back to the model rather than aborting the turn — the
    /// model gets to see and react to tool failures.
    async fn call(&self, input: Value) -> Result<String, String>;

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

/// Find a tool by name and execute one call, producing the result block to
/// send back. An unknown tool name is itself an error result: the model
/// hallucinated a tool, and should be told so.
pub async fn run_tool(tools: &[Box<dyn Tool>], id: &str, name: &str, input: Value) -> ContentBlock {
    let outcome = match tools.iter().find(|t| t.def().name == name) {
        Some(tool) => tool.call(input).await,
        None => Err(format!("unknown tool: {name}")),
    };
    let (content, is_error) = match outcome {
        Ok(content) => (content, false),
        Err(message) => (message, true),
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
