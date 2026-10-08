//! A subagent that starts a subagent of its own (nightshift backlog 329,
//! 2026-10-08). His words: "whenever a subagent spins up a subagent of its
//! own, it should alert the main agent … the main agent should be notified
//! of that every time and it should be responsible for ensuring that those
//! decisions are in line with the size of the problem and the usage the
//! given task should take."
//!
//! The brief hook ([`super::brief::decide`]) sees every call of every
//! subagent; a spawn with an `agent_id` is a nested one. Each is counted
//! against its parent here ([`NESTED_FILE`], per turn, under a lock since
//! the turn's hooks run at once): past the cap (Settings, "each may
//! start"; default 2 — blocker 1290) it is refused with [`refused_reason`];
//! each one let through, and each refused, is queued for the main thread
//! as a steering note ([`super::steer`], [`super::steer::MAIN`]) that its
//! next call carries — [`main_note`], which asks it to answer for the
//! spawn and stop a disproportionate one.

use std::collections::BTreeMap;
use std::path::Path;

/// The turn's nested spawns, by the parent's `agent_id`.
pub const NESTED_FILE: &str = "subagent-nested.json";

/// Zero the count (a turn starts).
pub fn reset(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(NESTED_FILE));
}

/// Claim one nested spawn for `parent` under `cap`: `Ok((its count now,
/// the turn's nested total))`, or `Err(its count)` when it is at the cap.
/// A file that cannot be opened or locked counts as nothing (the CLI's own
/// depth limit still stands behind it).
pub fn claim(dir: &Path, parent: &str, cap: usize) -> Result<(usize, usize), usize> {
    use std::io::{Read as _, Seek as _, Write as _};
    let _ = std::fs::create_dir_all(dir);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(NESTED_FILE))
    else {
        return Ok((1, 1));
    };
    if file.lock().is_err() {
        return Ok((1, 1));
    }
    let mut have = String::new();
    let _ = file.read_to_string(&mut have);
    let mut counts: BTreeMap<String, usize> = serde_json::from_str(&have).unwrap_or_default();
    let n = counts.get(parent).copied().unwrap_or(0);
    if n >= cap {
        return Err(n);
    }
    counts.insert(parent.to_string(), n + 1);
    let total = counts.values().sum();
    let _ = file.set_len(0);
    let _ = file.seek(std::io::SeekFrom::Start(0));
    let _ = file.write_all(
        serde_json::to_string(&counts)
            .unwrap_or_default()
            .as_bytes(),
    );
    Ok((n + 1, total))
}

/// What the refused subagent reads.
pub fn refused_reason(cap: usize) -> String {
    format!(
        "Not run: Nightloom lets one subagent start at most {cap} subagent{} of its own, and you \
         have started {cap}. Do this part of the work yourself, or finish and say in your report \
         what is left so the main agent can decide.",
        if cap == 1 { "" } else { "s" }
    )
}

/// The spawn's task, from the Agent call's input.
pub fn task_of(input: &serde_json::Value) -> String {
    let field = |k: &str| {
        input
            .get(k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let task = field("description")
        .or_else(|| field("prompt").map(|p| p.lines().next().unwrap_or(p)))
        .unwrap_or("(no description)");
    let mut t: String = task.chars().take(160).collect();
    if task.chars().count() > 160 {
        t.push('…');
    }
    t
}

/// The note the main thread's next call carries. `who` is the parent's
/// type (or id), `count` this parent's nested spawns so far, `total` the
/// turn's nested spawns, `turn_spawns` every spawn of the turn.
pub fn main_note(
    who: &str,
    task: &str,
    refused: bool,
    count: usize,
    cap: usize,
    total: usize,
    turn_spawns: usize,
) -> String {
    if refused {
        return format!(
            "[Nightloom, not from Swaraag] Your subagent \u{201c}{who}\u{201d} tried to start a \
             subagent of its own (\u{201c}{task}\u{201d}) and was refused: it has used its {cap}. \
             It was told to do the work itself or report what is left to you."
        );
    }
    format!(
        "[Nightloom, not from Swaraag] Your subagent \u{201c}{who}\u{201d} started a subagent of \
         its own: \u{201c}{task}\u{201d} ({count} of the {cap} it may start; {total} nested this \
         turn, {turn_spawns} subagents started this turn in all). You answer for every subagent \
         under you: if one more agent is out of proportion to this task's size and the usage it \
         should take, stop it now (TaskStop) and do that part yourself or tell Swaraag; if it \
         fits, carry on. Say which in your reply."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_parent_gets_its_own_count_and_the_third_is_refused() {
        let dir = std::env::temp_dir().join(format!("nightloom-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(claim(&dir, "a", 2), Ok((1, 1)));
        assert_eq!(claim(&dir, "b", 2), Ok((1, 2)));
        assert_eq!(claim(&dir, "a", 2), Ok((2, 3)));
        assert_eq!(claim(&dir, "a", 2), Err(2));
        reset(&dir);
        assert_eq!(claim(&dir, "a", 2), Ok((1, 1)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_task_is_the_description_or_the_prompts_first_line() {
        let t = task_of(&serde_json::json!({"description": "scan the logs", "prompt": "x"}));
        assert_eq!(t, "scan the logs");
        let t = task_of(&serde_json::json!({"prompt": "read a.txt\nthen b"}));
        assert_eq!(t, "read a.txt");
    }

    /// The real CLI and the real hook (backlog 329): a background subagent
    /// that tries to start three of its own — two run, the third is
    /// refused, the main thread's queue holds the reports — and the main
    /// reply that ends while it runs says so (`StillRunning`). Haiku.
    /// Needs the desktop binary built (`NIGHTLOOM_HOOK_BIN`, else
    /// `target/debug/nightloom-desktop`). `cargo test -p nightloom-service
    /// --lib measure_nested -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn measure_nested_spawns_with_the_real_cli() {
        use crate::TurnEvent;
        use crate::agent::brief::BriefSpec;
        use crate::agent::{AgentSpec, ClaudeCodeAgent};
        let bin = std::env::var("NIGHTLOOM_HOOK_BIN").unwrap_or_else(|_| {
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../target/debug/nightloom-desktop"
            )
            .into()
        });
        let root = std::env::temp_dir().join(format!("nl-329-{}", uuid::Uuid::new_v4()));
        let work = root.join("work");
        let chat = root.join("chat");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&chat).unwrap();
        let mut spec = AgentSpec::new(&work);
        spec.binary = "claude".into();
        spec.model = Some("haiku".into());
        spec.no_session_persistence = true;
        spec.brief = Some(BriefSpec {
            hook: vec![bin, "--subagent-hook".into()],
            dir: chat.clone(),
            text: "<nightloom-subagent-brief>Test run.</nightloom-subagent-brief>".into(),
        });
        let agent = ClaudeCodeAgent::new(spec);
        let prompt = "Use the Agent tool exactly once, with run_in_background set to true and \
            subagent_type general-purpose, description \"coordinator\", and this task for it: \
            'Use the Agent tool three times, one call after another (wait for each), each time \
            starting a general-purpose subagent whose task is: reply with the single word hi. \
            Then report what each said, and any refusal word for word.' Do not wait for it: right \
            after launching it, reply LAUNCHED and end your reply.";
        let t0 = std::time::Instant::now();
        let mut log = Vec::new();
        let cancel = tokio_util::sync::CancellationToken::new();
        let out = agent
            .run_turn(prompt, &cancel, &mut |e: TurnEvent| {
                let ms = t0.elapsed().as_millis();
                match &e {
                    TurnEvent::ToolCall { name, .. } => {
                        log.push(format!("{ms:>6} main call {name}"))
                    }
                    TurnEvent::Subagent { event, .. } => match event.as_ref() {
                        TurnEvent::ToolCall { name, input, .. }
                            if name == "Agent" || name == "Task" =>
                        {
                            log.push(format!(
                                "{ms:>6} NESTED spawn {}",
                                input
                                    .get("description")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or("?")
                            ))
                        }
                        TurnEvent::ToolResult {
                            content, is_error, ..
                        } if content.contains("Not run") || *is_error => log.push(format!(
                            "{ms:>6} nested result (error={is_error}) {}",
                            content.chars().take(160).collect::<String>()
                        )),
                        _ => {}
                    },
                    TurnEvent::StillRunning { tasks } => {
                        log.push(format!("{ms:>6} STILL_RUNNING {tasks:?}"))
                    }
                    _ => {}
                }
            })
            .await
            .unwrap();
        log.push(format!(
            "{:>6} ended rounds={:?} text={:?}",
            t0.elapsed().as_millis(),
            out.rounds,
            out.text.chars().take(200).collect::<String>()
        ));
        let steer = crate::agent::steer::read(&chat);
        log.push(format!(
            "main queue: {} waiting, {} delivered",
            steer
                .queued
                .get(crate::agent::steer::MAIN)
                .map_or(0, Vec::len),
            steer
                .delivered
                .iter()
                .filter(|d| d.agent_id == crate::agent::steer::MAIN)
                .count()
        ));
        for q in steer
            .queued
            .get(crate::agent::steer::MAIN)
            .into_iter()
            .flatten()
        {
            log.push(format!(
                "  waiting: {}",
                q.text.chars().take(200).collect::<String>()
            ));
        }
        for d in steer
            .delivered
            .iter()
            .filter(|d| d.agent_id == crate::agent::steer::MAIN)
        {
            log.push(format!(
                "  delivered on {}: {}",
                d.tool,
                d.text.chars().take(200).collect::<String>()
            ));
        }
        println!("{}", log.join("\n"));
    }
}
