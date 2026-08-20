//! Built-in tools: the file, search, shell, and planning capability every
//! shell (CLI, desktop) offers.
//!
//! Two things here are load-bearing beyond the code itself.
//!
//! **Descriptions are prompt text.** A `ToolDef.description` is not
//! documentation; it is the only instruction the model gets about when to
//! reach for a tool and how to use it well, and it is paid for on every
//! request. They are written as instructions ("read the file before editing
//! it", "use grep instead of shelling out to rg"), and they are built with
//! `\`-continued literals so that no accidental run of indentation leaks into
//! the model's context — a defect that is invisible in the source and very
//! visible in the tokens.
//!
//! **Errors are prompt text too.** [`Tool::call`]'s `Err` becomes a
//! `ToolResult` with `is_error: true` that is fed straight back to the model,
//! so every message here says what to do next, not merely what went wrong.
//!
//! Path-taking tools are confined to a [`Root`] — see that type for what the
//! confinement does and does not cover.

mod compact;
mod files;
mod review;
mod root;
mod search;
mod shell;
mod task;
mod todo;

pub use compact::{CompactContext, CompactSignal};
pub use review::{Review, Reviewer, ReviewerSpec, bench};
pub use root::Root;
pub use task::{Subagent, TurnHandle};
pub use todo::TodoWrite;

use chrono::{Local, Utc};
use nightloom_core::ToolDef;
use nightloom_core::tool::{Effect, Tool};
use serde_json::{Value, json};
use std::path::PathBuf;

pub(crate) const READ_LIMIT: usize = 16 * 1024;

/// The built-in tools, confined to the current working directory.
pub fn builtin() -> Vec<Box<dyn Tool>> {
    builtin_in(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// The built-in tools, with every path argument resolved against — and
/// confined to — `root`.
pub fn builtin_in(root: impl Into<PathBuf>) -> Vec<Box<dyn Tool>> {
    let root = Root::new(root);
    vec![
        Box::new(files::ReadFile::new(root.clone())),
        Box::new(files::WriteFile::new(root.clone())),
        Box::new(files::EditFile::new(root.clone())),
        Box::new(files::ListDir::new(root.clone())),
        Box::new(search::Glob::new(root.clone())),
        Box::new(search::Grep::new(root.clone())),
        Box::new(shell::Bash::new(root)),
        Box::new(CurrentTime),
        Box::new(TodoWrite::default()),
    ]
}

fn path_arg(input: &Value) -> Result<String, String> {
    str_arg(input, "path")
}

fn str_arg(input: &Value, name: &str) -> Result<String, String> {
    input[name]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("missing required argument: {name}"))
}

fn truncated(text: String) -> String {
    if text.len() <= READ_LIMIT {
        return text;
    }
    let mut cut = READ_LIMIT;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}… (truncated)", &text[..cut])
}

#[cfg(test)]
pub(crate) fn test_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nightloom-tools-{}-{name}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct CurrentTime;

#[async_trait::async_trait]
impl Tool for CurrentTime {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "current_time".into(),
            description: "Get the current date and time, local and UTC.".into(),
            input_schema: json!({ "type": "object", "properties": {} }),
        }
    }

    async fn call(&self, _input: Value) -> Result<String, String> {
        Ok(format!(
            "local: {}\nutc:   {}",
            Local::now().format("%Y-%m-%d %H:%M:%S %:z"),
            Utc::now().format("%Y-%m-%d %H:%M:%S UTC"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::tool::run_tool;

    #[tokio::test]
    async fn current_time_reports_local_and_utc() {
        let out = CurrentTime.call(json!({})).await.unwrap();
        assert!(out.starts_with("local: "));
        assert!(out.contains("\nutc:   "));
        assert!(out.ends_with(" UTC"));
    }

    #[tokio::test]
    async fn unknown_tool_becomes_error_result() {
        let tools = builtin();
        let block = run_tool(&tools, "c1", "no_such_tool", json!({})).await;
        assert!(matches!(
            block,
            nightloom_core::ContentBlock::ToolResult { is_error: true, .. }
        ));
    }

    #[test]
    fn the_tool_set_is_the_advertised_one() {
        let names: Vec<String> = builtin().iter().map(|t| t.def().name).collect();
        assert_eq!(
            names,
            [
                "read_file",
                "write_file",
                "edit_file",
                "list_dir",
                "glob",
                "grep",
                "bash",
                "current_time",
                "todo_write",
            ]
        );
    }

    /// The classification an approval policy sorts on, pinned in one place.
    ///
    /// A tool that never declares an effect is `Mutating`, so the risk this
    /// guards against is the opposite one: a tool talked into `ReadOnly`
    /// because it is *usually* harmless, after which no user is ever asked
    /// about it again.
    #[test]
    fn effects_are_classified_deliberately() {
        let mut tools = builtin();
        tools.push(Box::new(CompactContext::new(CompactSignal::new())));
        let classified: Vec<(String, Effect)> =
            tools.iter().map(|t| (t.def().name, t.effect())).collect();
        assert_eq!(
            classified,
            [
                ("read_file", Effect::ReadOnly),
                ("write_file", Effect::Mutating),
                ("edit_file", Effect::Mutating),
                ("list_dir", Effect::ReadOnly),
                ("glob", Effect::ReadOnly),
                ("grep", Effect::ReadOnly),
                ("bash", Effect::Mutating),
                ("current_time", Effect::ReadOnly),
                ("todo_write", Effect::Session),
                ("compact_context", Effect::Session),
            ]
            .map(|(name, effect)| (name.to_string(), effect))
        );
    }

    /// Descriptions are tokens the model reads on every request. A wrapped
    /// literal that forgets its line-continuation backslash leaks a long run
    /// of source indentation into the prompt, which is invisible in the
    /// source and was a real defect here — this is the guard against it
    /// coming back.
    #[test]
    fn descriptions_carry_no_stray_whitespace() {
        // The two that are not in `builtin()` still ship descriptions the
        // model pays for, and are the likeliest to be missed by this guard.
        let mut tools = builtin();
        tools.push(Box::new(CompactContext::new(CompactSignal::new())));
        tools.push(Box::new(Subagent::new(
            std::sync::Arc::new(|| Err("not used".into())),
            std::sync::Arc::new(TurnHandle::default()),
        )));
        tools.push(Box::new(Review::new(
            vec![Reviewer::new(
                "gemini",
                "gemini-3-pro, from Google",
                std::sync::Arc::new(|| Err("not used".into())),
            )],
            Root::new("."),
            std::sync::Arc::new(TurnHandle::default()),
        )));
        for tool in tools {
            let def = tool.def();
            let d = &def.description;
            assert!(!d.is_empty(), "{}: empty description", def.name);
            assert!(
                !d.contains("  "),
                "{}: description contains a run of spaces",
                def.name
            );
            assert!(
                !d.contains('\t') && !d.contains(" \n") && !d.contains("\n "),
                "{}: description contains stray indentation",
                def.name
            );
            assert_eq!(d.trim(), d, "{}: description is not trimmed", def.name);
        }
    }
}
