//! A second opinion from a different model, on a document this one wrote.
//!
//! An hour of planning with one model produces a document that a *different*
//! model, usually a different vendor, picks holes in on first read. Three
//! separate things cause that, and they are worth separating because only one
//! of them is expensive to arrange:
//!
//! 1. **A different prior.** Models fail differently, and systematically. This
//!    is the large effect and the only one a same-model critic cannot supply
//!    at all.
//! 2. **No sunk context.** The author has the whole hour in its window — every
//!    alternative it rejected, every place the user agreed — and reads the
//!    document through the memory of having written it. A cold reader sees
//!    only the artifact, which is also all the implementer will ever see. If
//!    the document only makes sense given the conversation, *that is the
//!    finding*.
//! 3. **Evaluating is not generating.** Even the same model critiques better
//!    than it avoids the mistake. Real, and the smallest of the three.
//!
//! So this is [`Subagent`](super::task::Subagent) with two deliberate changes,
//! and neither is cosmetic.
//!
//! **The sub-chat comes from a different factory**, one the shell built
//! against another provider. A shell with no second key offers no reviewers
//! and the tool is never advertised — what it must never do is quietly fall
//! back to the model being reviewed, which returns something that looks like
//! a second opinion and is not, the worst outcome available here.
//!
//! **The reviewer is stripped to read-only tools by this module**, not by the
//! factory. A critic that can edit is a second author, and the independent
//! read is the thing being paid for. Doing it here rather than trusting the
//! shell is what makes [`Effect::ReadOnly`] on this tool *true* rather than a
//! classification talked down — see [`Review::effect`].
//!
//! What comes back is text, into the turn, like any other tool result. It is
//! deliberately not written to a file: the findings belong to the *version* of
//! the document that was reviewed, so a `plan.review.md` left in the docspace
//! goes stale the moment the parent acts on it — and worse, it is then indexed
//! into the next chat's system prompt, advertising problems that were fixed.
//! The session log is the durable record, with an ordering a file would not
//! have, and the revised document is the artifact meant to survive. Returning
//! inline is also the only shape that lets the parent do the useful half:
//! *check* each finding against the code before believing it.

use super::root::Root;
use super::task::TurnHandle;
use crate::turn::Chat;
use nightloom_core::tool::{Effect, Tool};
use nightloom_core::{Session, ToolDef};
use serde_json::{Value, json};
use std::sync::Arc;

/// One configured second opinion: a name the model asks for, a description of
/// what it actually is, and how to build it.
///
/// The description is prompt text — it is how the model chooses between
/// reviewers, so it should name the vendor and model rather than being
/// decorative ("gemini-3-pro, from Google").
pub struct Reviewer {
    pub name: String,
    pub description: String,
    pub factory: Arc<dyn Fn() -> Result<Chat, String> + Send + Sync>,
}

impl Reviewer {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        factory: Arc<dyn Fn() -> Result<Chat, String> + Send + Sync>,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            factory,
        }
    }
}

const REVIEW_DESC: &str = "Get an adversarial read of a document from a different model. It runs \
     in its own context with read-only access to this workspace, and it cannot see this \
     conversation — it sees the file you name and whatever it opens itself, which is exactly what \
     the person implementing that document would see.\n\
     Reach for it on a plan, design or spec before acting on it. A second model with a different \
     prior finds what this one's attention did not, and that is cheap next to building the wrong \
     thing. If what you want reviewed is not written down yet, write it first: a proposal that \
     only exists in this conversation cannot be reviewed by something outside it, and could not \
     be implemented from either.\n\
     What comes back is claims, not instructions. Check each one — you have the files and the \
     reviewer can be wrong about them — then answer it: fix what is real, and say plainly which \
     findings you are rejecting and why. Do not apply every finding on sight. A document rewritten \
     to satisfy every objection is longer, hedged and worse than the one you started with.";

const AVAILABLE: &str = "\nAvailable reviewers (one is usually enough; ask two or three in a \
     single batch when the stakes are high, and treat what they independently agree on as the \
     strongest signal):";

/// The instruction the reviewer is given.
///
/// Composed here rather than passed through from the parent, and that is the
/// point of the tool existing separately from `task`: the adversarial framing
/// and the shape a finding has to take are guaranteed regardless of how the
/// parent asked. Ask a model "is this plan good?" and it says "looks solid,
/// consider adding tests", which is worth nothing.
///
/// Three devices are doing the work. Findings must carry the *condition* under
/// which the thing goes wrong, which is what separates a defect from a
/// preference. Verification is demanded before any claim about the codebase,
/// because a cold reader's most common failure is objecting to something the
/// document settles two sections down or asserting something about code it
/// never opened. And "I found nothing serious" is stated up front as a valid
/// answer, because a reviewer that believes it owes you a list will produce
/// one.
fn instruction(path: &str, focus: Option<&str>) -> String {
    let mut p = format!(
        "You are reviewing a document at `{path}`, written by someone else. You have read-only \
         file tools rooted at the working directory it lives in.\n\n\
         Read it. Then read whatever code, config or other files it makes claims about — do that \
         before contradicting it, because an objection to this codebase that you have not opened \
         the codebase to check is the least useful thing you can return.\n\n\
         Report defects, most serious first. Each one gets three things: where it is (quote the \
         heading or the line), what specifically goes wrong, and the condition under which it goes \
         wrong — the input, the state, the sequence of steps, the case that was not considered. A \
         concern you cannot state in that form is a preference, not a defect; leave it out.\n\n\
         Do not summarize the document. Do not list what it does well. Do not propose \
         reorganizations, stylistic changes, or additions that would merely be nice to have.\n\n\
         If you find nothing serious, say so in one line and name the two or three things you \
         checked hardest. That is a complete and useful answer, and it is better than a list \
         padded to look thorough."
    );
    if let Some(focus) = focus.map(str::trim).filter(|f| !f.is_empty()) {
        p.push_str(
            "\n\nThe author asks you to pay particular attention to this, without \
                    limiting yourself to it:\n",
        );
        p.push_str(focus);
    }
    p
}

/// The `review` tool. Build it through [`Chat::enable_reviews`], which wires
/// the turn handle — the reviewer list alone is not enough.
pub struct Review {
    reviewers: Vec<Reviewer>,
    root: Root,
    handle: Arc<TurnHandle>,
}

impl Review {
    pub fn new(reviewers: Vec<Reviewer>, root: Root, handle: Arc<TurnHandle>) -> Self {
        Self {
            reviewers,
            root,
            handle,
        }
    }

    fn names(&self) -> String {
        self.reviewers
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[async_trait::async_trait]
impl Tool for Review {
    /// Honestly read-only, because [`Review::call`] strips the sub-chat to
    /// read-only tools itself. Nothing the shell's factory hands over can
    /// change that, which is what makes this different from classifying
    /// `task` — a subagent runs whatever its tool set allows, so it stays
    /// `Mutating`.
    ///
    /// Two things follow. The approval gate answers it without asking, and the
    /// engine overlaps *adjacent* read-only calls — so a model that asks three
    /// reviewers in one round gets all three concurrently, and the panel is
    /// not a separate feature. What it costs is that a call against a second
    /// provider is not free and is never prompted for; the tool description
    /// carries that weight instead, on the same footing as every other
    /// instruction about when to reach for a tool.
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        let mut description = String::from(REVIEW_DESC);
        description.push_str(AVAILABLE);
        for r in &self.reviewers {
            description.push_str(&format!("\n- {}: {}", r.name, r.description));
        }
        ToolDef {
            name: "review".into(),
            description,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "reviewer": {
                        "type": "string",
                        "enum": self.reviewers.iter().map(|r| r.name.clone()).collect::<Vec<_>>(),
                        "description": "Which reviewer to ask."
                    },
                    "path": {
                        "type": "string",
                        "description": "The document to review, relative to the workspace."
                    },
                    "focus": {
                        "type": "string",
                        "description": "Optional. What you are least sure about, in a sentence. \
                                        The reviewer is told to weigh it without stopping there."
                    }
                },
                "required": ["reviewer", "path"]
            }),
        }
    }

    async fn call(&self, input: Value) -> Result<String, String> {
        let name = input["reviewer"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        let reviewer = self
            .reviewers
            .iter()
            .find(|r| r.name.eq_ignore_ascii_case(&name))
            .ok_or_else(|| format!("no reviewer called {name:?}. Available: {}", self.names()))?;

        let path = input["path"]
            .as_str()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| {
                "missing required argument: path (the document to review)".to_string()
            })?;
        // Checked here rather than left to the reviewer, which would spend a
        // whole provider call to come back with "there is no such file".
        let resolved = self.root.resolve(path)?;
        if !resolved.is_file() {
            return Err(format!(
                "no file at {path}. Review takes a path in the workspace, not the text itself; \
                 write the document first if it is not on disk yet."
            ));
        }

        let mut chat = (reviewer.factory)()
            .map_err(|e| format!("cannot start the {} reviewer: {e}", reviewer.name))?;
        // The whole safety argument in one line: whatever the shell's factory
        // returned, the reviewer holds nothing that writes. This also removes
        // `task` (a subagent is `Mutating`), so a reviewer cannot delegate its
        // way back to a tool set it was denied.
        //
        // `review` is the one read-only tool that has to go by name. A shell
        // that builds its reviewers with the same function it builds the main
        // chat with — which is the sane way to write it, and what both shells
        // here do — hands back a chat holding this tool, and a reviewer that
        // can order a review is an unbounded fan-out where each level costs a
        // provider call. Same argument as `task` stripping `task`, and the
        // same depth is the useful one: a second opinion on a second opinion
        // is not a third prior, it is the first one again.
        chat.tools
            .retain(|t| t.effect() == Effect::ReadOnly && t.def().name != "review");
        // Every remaining tool is one the policy answers itself, so this
        // changes no behaviour today. It is here because the alternative — a
        // subagent deliberately built without a gate — is the wrong thing to
        // leave lying around for the day someone misclassifies a tool.
        chat.approver = self.handle.approver();

        let mut session = Session::new();
        let cancel = self.handle.cancel();
        let outcome = chat
            .run_turn(
                &mut session,
                instruction(path, input["focus"].as_str()),
                &cancel,
                &mut |_| {},
            )
            .await
            .map_err(|e| format!("the {} reviewer failed: {e}", reviewer.name))?;
        if outcome.interrupted {
            return Err(format!(
                "the {} reviewer was interrupted before it finished",
                reviewer.name
            ));
        }

        let answer = session
            .messages()
            .iter()
            .rev()
            .find(|m| m.role == nightloom_core::Role::Assistant)
            .map(|m| m.text().trim().to_string())
            .unwrap_or_default();
        if answer.is_empty() {
            return Err(format!(
                "the {} reviewer finished without producing an answer; it may have run out of \
                 tool rounds.",
                reviewer.name
            ));
        }
        // Attributed, because three of these can come back in one round and
        // findings from different priors are not interchangeable — which two
        // reviewers independently agree on is the signal.
        Ok(format!(
            "review of {path} by {} ({}):\n\n{answer}",
            reviewer.name, reviewer.description
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{Subagent, builtin_in, test_dir};
    use crate::turn::tests::{chat_scripted, says, tool_call};
    use nightloom_core::StreamEvent;
    use std::fs;
    use std::sync::Mutex;

    /// A reviewer whose sub-chat is scripted and whose tool set is whatever a
    /// careless shell handed over. Both are yielded once, which is all a
    /// single `review` call needs.
    fn reviewer_over(tools: Vec<Box<dyn Tool>>, scripts: Vec<Vec<StreamEvent>>) -> Reviewer {
        let parts = Arc::new(Mutex::new(Some((tools, scripts))));
        Reviewer::new(
            "other",
            "a different model",
            Arc::new(move || {
                let (tools, scripts) = parts.lock().unwrap().take().unwrap_or_default();
                let mut chat = chat_scripted(scripts);
                chat.tools = tools;
                Ok(chat)
            }),
        )
    }

    fn review_in(dir: &std::path::Path, reviewer: Reviewer) -> Review {
        Review::new(
            vec![reviewer],
            Root::new(dir),
            Arc::new(TurnHandle::default()),
        )
    }

    /// The classification is only honest because this module enforces it. A
    /// factory that hands back the parent's whole tool set must still produce
    /// a reviewer that cannot write, or `Effect::ReadOnly` on `review` is a
    /// claim nobody is keeping — and the model would have a way to run a
    /// mutating tool that the approval gate never sees.
    #[tokio::test]
    async fn a_reviewer_cannot_hold_a_tool_that_writes() {
        let dir = test_dir("review-readonly");
        fs::write(
            dir.join("plan.md"),
            "# Plan
",
        )
        .unwrap();
        let review = review_in(
            &dir,
            reviewer_over(
                builtin_in(&dir),
                vec![
                    tool_call(
                        "write_file",
                        json!({ "path": "sneaky.txt", "content": "x" }),
                    ),
                    says("nothing serious"),
                ],
            ),
        );

        let out = review
            .call(json!({ "reviewer": "other", "path": "plan.md" }))
            .await
            .unwrap();

        assert_eq!(review.effect(), Effect::ReadOnly);
        assert!(out.starts_with("review of plan.md by other"), "{out}");
        assert!(out.contains("nothing serious"), "{out}");
        assert!(
            !dir.join("sneaky.txt").exists(),
            "the reviewer reached a tool that writes"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// `task` is `Mutating`, so stripping to read-only removes it too — a
    /// reviewer cannot delegate its way back to the tool set it was denied.
    #[tokio::test]
    async fn a_reviewer_cannot_delegate_its_way_out() {
        let dir = test_dir("review-nodelegate");
        fs::write(
            dir.join("plan.md"),
            "# Plan
",
        )
        .unwrap();
        let mut tools = builtin_in(&dir);
        tools.push(Box::new(Subagent::new(
            Arc::new(|| panic!("a reviewer spawned a subagent")),
            Arc::new(TurnHandle::default()),
        )));
        let review = review_in(
            &dir,
            reviewer_over(
                tools,
                vec![
                    tool_call("task", json!({ "prompt": "do the work for me" })),
                    says("nothing serious"),
                ],
            ),
        );
        review
            .call(json!({ "reviewer": "other", "path": "plan.md" }))
            .await
            .unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    /// A shell that builds reviewers with the same function it builds the
    /// main chat with hands back a chat holding `review` — which is read-only,
    /// so the effect filter alone would keep it, and each level of it costs a
    /// provider call.
    #[tokio::test]
    async fn a_reviewer_cannot_order_a_review() {
        let dir = test_dir("review-norecurse");
        fs::write(
            dir.join("plan.md"),
            "# Plan
",
        )
        .unwrap();
        let inner = Review::new(
            vec![Reviewer::new(
                "other",
                "a different model",
                Arc::new(|| panic!("a reviewer ordered a review")),
            )],
            Root::new(&dir),
            Arc::new(TurnHandle::default()),
        );
        let review = review_in(
            &dir,
            reviewer_over(
                vec![Box::new(inner)],
                vec![
                    tool_call("review", json!({ "reviewer": "other", "path": "plan.md" })),
                    says("nothing serious"),
                ],
            ),
        );
        review
            .call(json!({ "reviewer": "other", "path": "plan.md" }))
            .await
            .unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    /// A path that is not on disk costs a clear error rather than a whole
    /// provider call that comes back saying the file is missing.
    #[tokio::test]
    async fn a_document_that_is_not_written_down_cannot_be_reviewed() {
        let dir = test_dir("review-missing");
        let review = review_in(&dir, reviewer_over(Vec::new(), Vec::new()));
        let err = review
            .call(json!({ "reviewer": "other", "path": "plan.md" }))
            .await
            .unwrap_err();
        assert!(err.contains("write the document first"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    /// An unconfigured name comes back as the list of names that exist. There
    /// is deliberately no default reviewer to fall back to: the fallback would
    /// be the model under review, and a second opinion from the author is the
    /// one answer this tool must never return.
    #[tokio::test]
    async fn an_unconfigured_reviewer_is_refused_by_name() {
        let dir = test_dir("review-unknown");
        let review = review_in(&dir, reviewer_over(Vec::new(), Vec::new()));
        let err = review
            .call(json!({ "reviewer": "gemini", "path": "plan.md" }))
            .await
            .unwrap_err();
        assert!(err.contains("no reviewer called"), "{err}");
        assert!(err.contains("other"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    /// The reviewer's instruction belongs to the tool, not the caller: the
    /// framing is what makes the answer worth having, so it cannot be
    /// something the parent can decline to include.
    #[test]
    fn the_adversarial_framing_is_not_the_parents_to_supply() {
        let p = instruction("plan.md", Some("the retry path"));
        assert!(p.contains("Report defects, most serious first"));
        assert!(p.contains("Do not summarize the document"));
        assert!(p.contains("the retry path"));
        // "Nothing found" has to be sayable, or a reviewer invents a list.
        assert!(p.contains("If you find nothing serious"));
        assert!(instruction("plan.md", Some("   ")).len() < p.len());
    }

    /// A tool nobody can reach is worse than no tool: it costs prompt tokens
    /// on every request and every call it invites comes back as an error.
    #[test]
    fn no_reviewers_means_no_tool() {
        let mut chat = chat_scripted(Vec::new());
        chat.enable_reviews(Vec::new(), Root::new("."));
        assert!(chat.tools.is_empty());
    }
}
