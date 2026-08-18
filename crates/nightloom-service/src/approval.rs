//! Consent for tool calls: the contract a shell implements to put a human
//! between the model and anything it wants to do to the machine.
//!
//! The engine asks and the shell answers — this crate renders nothing and
//! reads no input, so what "asking" looks like (a terminal line, a modal, a
//! policy file) stays the shell's business, exactly as with [`TurnEvent`] and
//! the cancellation token.
//!
//! A refusal is not an abort. It comes back to the model as an `is_error`
//! tool result and the turn carries on, which is the same contract
//! [`Tool::call`]'s `Err` already has: the model is told what happened and
//! gets to adapt. Aborting the turn instead would leave the `tool_use` block
//! without a matching result, which is invalid on replay.
//!
//! [`TurnEvent`]: crate::TurnEvent
//! [`Tool::call`]: nightloom_core::tool::Tool::call

use nightloom_core::Effect;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// One call awaiting a decision, borrowed from the turn engine's state — it
/// exists only for the duration of the [`Approver::approve`] call.
#[derive(Debug)]
pub struct PendingCall<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub input: &'a Value,
    pub effect: Effect,
}

/// What to do with a pending call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Allow this and every later call to the same tool this session.
    ///
    /// The engine treats this exactly like [`Allow`](Decision::Allow) — the
    /// remembering is the policy's job, so that a shell can choose how long
    /// "this session" lasts. [`AutoApprove`] implements the usual answer.
    AllowAlways,
    /// Refused, with a reason the model is told. An empty reason is fine;
    /// the model still learns the call did not run.
    Deny(String),
}

/// Consent policy for tool calls.
#[async_trait::async_trait]
pub trait Approver: Send + Sync {
    /// Decide one call. Called before the tool runs, once per call, on every
    /// round including the last.
    ///
    /// Takes `&self` because the policy is shared and long-lived; anything
    /// it remembers between calls needs interior mutability.
    async fn approve(&self, call: &PendingCall<'_>) -> Decision;
}

/// The policy every shell wants: [`Effect::ReadOnly`] and
/// [`Effect::Session`] calls pass without asking, [`Effect::Mutating`] ones
/// go to `inner`, and an [`AllowAlways`](Decision::AllowAlways) answer is
/// remembered per tool name so the same question is not asked twice.
///
/// Sorting on effect rather than on a name list is what keeps this honest as
/// tools are added: a new tool that never declared an effect is `Mutating`
/// by default and lands in front of the user, instead of being waved through
/// because nobody remembered to add it to a list.
///
/// The memory is per tool *name*, not per call: "always allow `read_file`"
/// is a statement about the tool, and a `write_file` approval says nothing
/// about `bash`.
pub struct AutoApprove {
    inner: Arc<dyn Approver>,
    always: Mutex<HashSet<String>>,
}

impl AutoApprove {
    pub fn new(inner: Arc<dyn Approver>) -> Self {
        Self {
            inner,
            always: Mutex::new(HashSet::new()),
        }
    }

    /// Same policy over a plain closure, for a shell whose prompt is
    /// synchronous (a terminal read) or whose rule is a pure function.
    ///
    /// The closure runs inside the turn's async task: anything that blocks
    /// for a long time belongs behind `spawn_blocking` in a full
    /// [`Approver`] impl instead.
    pub fn from_fn<F>(decide: F) -> Self
    where
        F: Fn(&PendingCall<'_>) -> Decision + Send + Sync + 'static,
    {
        Self::new(Arc::new(FnApprover(decide)))
    }

    /// Pre-approve a tool by name, as `--allow-tool bash` would.
    pub fn always_allow(&self, name: impl Into<String>) {
        self.always.lock().unwrap().insert(name.into());
    }
}

#[async_trait::async_trait]
impl Approver for AutoApprove {
    async fn approve(&self, call: &PendingCall<'_>) -> Decision {
        match call.effect {
            // Looking at the workspace and writing the task list are things
            // the model does constantly and cannot use to damage anything;
            // prompting on them trains the user to answer without reading,
            // which is how the prompts that matter stop working.
            Effect::ReadOnly | Effect::Session => return Decision::Allow,
            Effect::Mutating => {}
        }
        if self.always.lock().unwrap().contains(call.name) {
            return Decision::Allow;
        }
        let decision = self.inner.approve(call).await;
        if decision == Decision::AllowAlways {
            self.always.lock().unwrap().insert(call.name.to_string());
        }
        decision
    }
}

struct FnApprover<F>(F);

#[async_trait::async_trait]
impl<F> Approver for FnApprover<F>
where
    F: Fn(&PendingCall<'_>) -> Decision + Send + Sync + 'static,
{
    async fn approve(&self, call: &PendingCall<'_>) -> Decision {
        (self.0)(call)
    }
}

/// What the model is told when a call is refused.
///
/// This is prompt text, not a log line: it is delivered as an `is_error`
/// tool result the model has to act on, so it says what to do next. Retrying
/// the identical call is the one behaviour worth ruling out explicitly —
/// it is what a model does with a bare failure, and here it would only
/// produce a second prompt for the user to refuse.
pub(crate) fn denial_message(name: &str, reason: &str) -> String {
    let reason = reason.trim();
    let mut message = format!(
        "The user refused permission to run {name}, so it did not run. Do not \
call it again with the same arguments."
    );
    if !reason.is_empty() {
        message.push_str("\nThey said: ");
        message.push_str(reason);
    }
    message.push_str(
        "\nTell them what you were trying to do and why, then either take the \
approach they asked for or ask how they want to proceed.",
    );
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Counts what it was asked about, so a test can prove a question was
    /// *not* asked — the interesting half of this policy.
    struct Counting {
        asked: Mutex<Vec<String>>,
        decision: Decision,
    }

    impl Counting {
        fn new(decision: Decision) -> Arc<Self> {
            Arc::new(Self {
                asked: Mutex::new(Vec::new()),
                decision,
            })
        }
    }

    #[async_trait::async_trait]
    impl Approver for Counting {
        async fn approve(&self, call: &PendingCall<'_>) -> Decision {
            self.asked.lock().unwrap().push(call.name.to_string());
            self.decision.clone()
        }
    }

    async fn ask(policy: &AutoApprove, name: &str, effect: Effect) -> Decision {
        let input = json!({});
        policy
            .approve(&PendingCall {
                id: "c1",
                name,
                input: &input,
                effect,
            })
            .await
    }

    #[tokio::test]
    async fn harmless_effects_never_reach_the_inner_policy() {
        let inner = Counting::new(Decision::Deny(String::new()));
        let policy = AutoApprove::new(inner.clone());
        assert_eq!(
            ask(&policy, "read_file", Effect::ReadOnly).await,
            Decision::Allow
        );
        assert_eq!(
            ask(&policy, "todo_write", Effect::Session).await,
            Decision::Allow
        );
        assert!(inner.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn always_is_remembered_per_tool_name() {
        let inner = Counting::new(Decision::AllowAlways);
        let policy = AutoApprove::new(inner.clone());
        for _ in 0..3 {
            assert!(matches!(
                ask(&policy, "write_file", Effect::Mutating).await,
                Decision::AllowAlways | Decision::Allow
            ));
        }
        ask(&policy, "bash", Effect::Mutating).await;
        // Asked once about each: the second and third write_file calls rode
        // the memory, and bash never inherited write_file's approval.
        assert_eq!(*inner.asked.lock().unwrap(), ["write_file", "bash"]);
    }

    #[tokio::test]
    async fn a_plain_deny_is_asked_again_next_time() {
        let inner = Counting::new(Decision::Deny("no".into()));
        let policy = AutoApprove::new(inner.clone());
        ask(&policy, "bash", Effect::Mutating).await;
        ask(&policy, "bash", Effect::Mutating).await;
        assert_eq!(inner.asked.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn from_fn_sees_the_call_being_decided() {
        let policy = AutoApprove::from_fn(|call| {
            if call.input["path"] == json!("/etc/passwd") {
                Decision::Deny("not that file".into())
            } else {
                Decision::Allow
            }
        });
        let blocked = json!({"path": "/etc/passwd"});
        let decision = policy
            .approve(&PendingCall {
                id: "c1",
                name: "write_file",
                input: &blocked,
                effect: Effect::Mutating,
            })
            .await;
        assert_eq!(decision, Decision::Deny("not that file".into()));
    }

    #[test]
    fn the_denial_carries_the_reason_and_an_instruction() {
        let message = denial_message("bash", "  don't touch the database  ");
        assert!(message.contains("refused permission to run bash"));
        assert!(message.contains("don't touch the database"));
        assert!(message.ends_with("how they want to proceed."));
        // An empty reason must not leave a dangling "They said:".
        assert!(!denial_message("bash", "   ").contains("They said"));
    }
}
