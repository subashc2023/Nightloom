use crate::message::ContentBlock;
use crate::provider::ToolDef;
use crate::session::SessionEvent;
use serde_json::Value;

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

pub fn defs(tools: &[Box<dyn Tool>]) -> Vec<ToolDef> {
    tools.iter().map(|t| t.def()).collect()
}
