//! Same-type subagent spawns, staggered so the later ones read the first
//! one's cached prompt (nightshift item 761, 2026-11-19).
//!
//! The API caches a prompt prefix only once a request carrying it has
//! begun to answer. Helpers launched together each write the whole
//! system + tools prefix (~36k) themselves; one launched after a
//! same-type, same-model sibling's first reply reads it instead
//! (`notes/runner-design/wave-e-engine-report-2026-11-16.md`, 58 first
//! turns: 0 read together, ~36k read when after). So the Agent hook holds
//! the second and later spawns of one group — the caller (main thread or
//! the helper spawning), the `subagent_type`, the model — until the
//! group's first spawn has its first reply on disk, or [`HOLD_MAX_MS`].
//! The caller is the calling process's own id with its turn (review,
//! 2026-11-19): a main thread by its session, so two sessions sharing a
//! chat's folder (an aside, a checkpoint fork) never wait on each other's
//! leader, whose subagents sit in another folder; and a leader of an
//! earlier turn (one stopped before its first reply) holds no one now.
//! A single spawn never waits: the first of a group is the leader, and a
//! leader goes at once.
//!
//! The leader is recorded only after its call has passed every refusal
//! check (the hook calls [`hold`] last), so a refused spawn never makes
//! another wait. A turn stopped mid-hold ends the held hook with the CLI,
//! or at the timeout; its stale entry ages out.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The groups' ledger, beside the brief in the chat's directory.
pub const STAGGER_FILE: &str = "subagent-stagger.json";
/// The calls held now, for the window (by call id): what the read loop
/// shows on the Agent row while it waits.
pub const HELD_FILE: &str = "subagent-held.json";

/// The longest a later spawn waits for the first's first reply. Measured
/// 2026-11-19 on his disk: 730 subagent first replies of the last 7 days
/// (first transcript line → first assistant line): median 4.4 s, p90
/// 6.4 s, p95 8.1 s, 97.1 % within 10 s, max 41.7 s. Ten seconds covers
/// ~97 % and bounds the worst added wait.
pub const HOLD_MAX_MS: i64 = 10_000;
/// After a group's first reply, how long a later spawn of it goes at once
/// rather than leading a new group: the 5-minute cache's life.
pub const WARM_MS: i64 = 5 * 60 * 1000;
/// How often a held spawn looks for the first reply.
pub const POLL_MS: u64 = 200;

/// One group's state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Group {
    /// The leader's call id.
    pub leader: String,
    /// When the leader was let through (unix ms).
    pub since_ms: i64,
    /// The subagent files on disk when it was, so its own is the new one.
    #[serde(default)]
    pub before: Vec<String>,
    /// When its first reply was seen (or the hold timed out), if it was.
    #[serde(default)]
    pub released_ms: Option<i64>,
}

/// What [`role`] makes of a spawn.
#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    /// The first of its group: goes at once, recorded as leader.
    Lead,
    /// The group's first reply is in (or timed out) and its cache warm.
    Go,
    /// Wait for the leader's first reply, until `deadline_ms`.
    Wait {
        deadline_ms: i64,
        before: Vec<String>,
        leader: String,
    },
}

/// Pure: a spawn's role, given its group's entry and the time.
pub fn role(group: Option<&Group>, now_ms: i64) -> Role {
    match group {
        Some(g) if g.released_ms.is_none() && now_ms < g.since_ms + HOLD_MAX_MS => Role::Wait {
            deadline_ms: g.since_ms + HOLD_MAX_MS,
            before: g.before.clone(),
            leader: g.leader.clone(),
        },
        Some(g) if g.released_ms.is_some_and(|r| now_ms < r + WARM_MS) => Role::Go,
        _ => Role::Lead,
    }
}

/// The group's key: who spawns, of what type, on what model.
pub fn group_key(caller: &str, agent_type: &str, model: Option<&str>) -> String {
    format!(
        "{}|{}|{}",
        if caller.is_empty() { "main" } else { caller },
        agent_type,
        model.unwrap_or("-")
    )
}

/// The spawn's `subagent_type` as the CLI reads it (none: general-purpose).
pub fn agent_type_of(input: &Value) -> String {
    input
        .get("subagent_type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("general-purpose")
        .to_string()
}

/// The subagents' folder beside the session file.
pub fn subagents_dir(transcript: &Path) -> PathBuf {
    transcript.with_extension("").join("subagents")
}

/// The agent ids with a transcript in `dir` now.
pub fn agent_ids(dir: &Path) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(dir)
        .map(|es| {
            es.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().into_owned();
                    n.strip_prefix("agent-")
                        .and_then(|n| n.strip_suffix(".jsonl"))
                        .filter(|id| !id.is_empty())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids
}

/// Whether a new agent of `agent_type` (on `model`, when known) in `dir`
/// — one not in `before` — has its first reply written: an `assistant`
/// line in its transcript. The leader is known exactly when its
/// `.meta.json` names the spawning call (`toolUseId`, CLI 2.1.328): then
/// only the leader's own reply counts, not a same-type sibling's of
/// another group (a nested helper's, say) — review, 2026-11-19. A meta
/// with no call id counts by its `agentType`; a file with no meta by its
/// model alone.
pub fn first_reply_in(
    dir: &Path,
    before: &[String],
    leader: &str,
    agent_type: &str,
    model: Option<&str>,
) -> bool {
    agent_ids(dir)
        .into_iter()
        .filter(|id| !before.contains(id))
        .any(|id| {
            let meta = std::fs::read_to_string(dir.join(format!("agent-{id}.meta.json")))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok());
            let call = meta
                .as_ref()
                .and_then(|m| m.get("toolUseId")?.as_str())
                .filter(|c| !c.is_empty());
            if let Some(call) = call
                && call != leader
            {
                return false;
            }
            let meta_type = meta
                .as_ref()
                .and_then(|m| m.get("agentType")?.as_str());
            if call.is_none() && meta_type.is_some_and(|t| t != agent_type) {
                return false;
            }
            let Ok(text) = std::fs::read_to_string(dir.join(format!("agent-{id}.jsonl"))) else {
                return false;
            };
            text.lines().any(|l| {
                let Ok(v) = serde_json::from_str::<Value>(l) else {
                    return false;
                };
                if v.get("type").and_then(Value::as_str) != Some("assistant") {
                    return false;
                }
                match (model, v.pointer("/message/model").and_then(Value::as_str)) {
                    (Some(want), Some(got)) => got.to_ascii_lowercase().contains(want),
                    _ => true,
                }
            })
        })
}

/// Run `f` on the ledger under a file lock.
fn with_groups<T>(dir: &Path, f: impl FnOnce(&mut BTreeMap<String, Group>) -> T) -> Option<T> {
    with_locked(&dir.join(STAGGER_FILE), f)
}

fn with_locked<V, T>(path: &Path, f: impl FnOnce(&mut V) -> T) -> Option<T>
where
    V: Default + Serialize + for<'de> Deserialize<'de>,
{
    use std::io::{Read as _, Seek as _, Write as _};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .ok()?;
    file.lock().ok()?;
    let mut have = String::new();
    let _ = file.read_to_string(&mut have);
    let mut v: V = serde_json::from_str(&have).unwrap_or_default();
    let out = f(&mut v);
    let _ = file.set_len(0);
    let _ = file.seek(std::io::SeekFrom::Start(0));
    let _ = file.write_all(serde_json::to_string(&v).unwrap_or_default().as_bytes());
    Some(out)
}

/// One held call, as the window shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Held {
    pub text: String,
    pub since_ms: i64,
}

/// How old a held entry may be before it is taken for a hook that died
/// mid-hold (a turn stopped, the CLI killed): past the longest hold, with
/// room for a slow exit. Such an entry is not shown and is dropped at the
/// next write, so the file never outgrows the holds of the moment, in this
/// turn or the next (review, 2026-11-19).
pub const HELD_STALE_MS: i64 = HOLD_MAX_MS + 20_000;

fn fresh(h: &Held, now_ms: i64) -> bool {
    now_ms - h.since_ms < HELD_STALE_MS
}

/// The calls held now (the read loop's view).
pub fn read_held(dir: &Path) -> BTreeMap<String, Held> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut held: BTreeMap<String, Held> = std::fs::read_to_string(dir.join(HELD_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    held.retain(|_, h| fresh(h, now_ms));
    held
}

fn set_held(dir: &Path, id: &str, held: Option<Held>) {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let _ = with_locked(&dir.join(HELD_FILE), |m: &mut BTreeMap<String, Held>| {
        m.retain(|_, h| fresh(h, now_ms));
        match held {
            Some(h) => {
                m.insert(id.to_string(), h);
            }
            None => {
                m.remove(id);
            }
        }
    });
}

/// What the Agent row reads while it waits — plain words.
pub fn held_text(agent_type: &str) -> String {
    format!(
        "Held: waiting for the first {agent_type} helper's first reply, so this one starts \
         from its cached prompt (at most {} s)",
        HOLD_MAX_MS / 1000
    )
}

/// The note the model reads beside a held call once it goes.
pub fn held_note(agent_type: &str, waited_ms: i64, seen: bool) -> String {
    let s = (waited_ms as f64 / 1000.0 * 10.0).round() / 10.0;
    if seen {
        format!(
            "Nightloom held this spawn {s} s, until the first {agent_type} helper of this turn had its \
             first reply, so it reads that helper's cached prompt rather than writing its own."
        )
    } else {
        format!(
            "Nightloom held this spawn {s} s for the first {agent_type} helper's first reply, which did \
             not come in time; it starts now without the shared cache."
        )
    }
}

/// The hook's last step on a spawn it lets through: lead its group (go at
/// once), go (the group's cache is warm), or wait for the leader's first
/// reply. Returns the note for the model when it waited. `transcript` is
/// the main session file (the subagents' folder is beside it); without
/// one there is nothing to watch and the spawn goes at once.
#[allow(clippy::too_many_arguments)]
pub fn hold(
    dir: &Path,
    transcript: Option<&Path>,
    caller: &str,
    input: &Value,
    model: Option<&str>,
    tool_use_id: &str,
    now_ms: i64,
    hold_max_ms: i64,
    poll_ms: u64,
) -> Option<String> {
    let transcript = transcript?;
    let agents = subagents_dir(transcript);
    let agent_type = agent_type_of(input);
    let key = group_key(caller, &agent_type, model);
    let role = with_groups(dir, |gs| {
        // Old groups go (a day's worth of turns would pile up otherwise).
        gs.retain(|_, g| now_ms - g.since_ms < WARM_MS + hold_max_ms);
        let r = match role(gs.get(&key), now_ms) {
            Role::Wait { before, leader, .. } => Role::Wait {
                deadline_ms: gs.get(&key).map_or(now_ms, |g| g.since_ms) + hold_max_ms,
                before,
                leader,
            },
            r => r,
        };
        if r == Role::Lead {
            gs.insert(
                key.clone(),
                Group {
                    leader: tool_use_id.to_string(),
                    since_ms: now_ms,
                    before: agent_ids(&agents),
                    released_ms: None,
                },
            );
        }
        r
    })?;
    let Role::Wait {
        deadline_ms,
        before,
        leader,
    } = role
    else {
        return None;
    };
    set_held(
        dir,
        tool_use_id,
        Some(Held {
            text: held_text(&agent_type),
            since_ms: now_ms,
        }),
    );
    let mut seen = false;
    loop {
        let t = chrono::Utc::now().timestamp_millis();
        // Another follower may have seen it first.
        let released = std::fs::read_to_string(dir.join(STAGGER_FILE))
            .ok()
            .and_then(|s| serde_json::from_str::<BTreeMap<String, Group>>(&s).ok())
            .and_then(|gs| gs.get(&key).and_then(|g| g.released_ms))
            .is_some();
        if released || first_reply_in(&agents, &before, &leader, &agent_type, model) {
            seen = true;
            break;
        }
        if t >= deadline_ms {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(poll_ms));
    }
    let end = chrono::Utc::now().timestamp_millis();
    let _ = with_groups(dir, |gs| {
        if let Some(g) = gs.get_mut(&key)
            && g.released_ms.is_none()
        {
            g.released_ms = Some(end);
        }
    });
    set_held(dir, tool_use_id, None);
    Some(held_note(&agent_type, end - now_ms, seen))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-761-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn roles_follow_the_group() {
        assert_eq!(role(None, 1_000), Role::Lead);
        let g = Group {
            leader: "a".into(),
            since_ms: 1_000,
            before: vec![],
            released_ms: None,
        };
        assert!(matches!(
            role(Some(&g), 2_000),
            Role::Wait {
                deadline_ms: 11_000,
                ..
            }
        ));
        // Timed out without a release: a new spawn leads afresh.
        assert_eq!(role(Some(&g), 11_000), Role::Lead);
        let r = Group {
            released_ms: Some(3_000),
            ..g
        };
        assert_eq!(role(Some(&r), 4_000), Role::Go);
        assert_eq!(role(Some(&r), 3_000 + WARM_MS), Role::Lead);
    }

    #[test]
    fn keys_split_by_caller_type_and_model() {
        assert_eq!(
            group_key("", "reusable", Some("opus")),
            "main|reusable|opus"
        );
        assert_ne!(
            group_key("", "reusable", Some("opus")),
            group_key("", "reusable", Some("sonnet"))
        );
        assert_ne!(group_key("", "a", None), group_key("x1", "a", None));
        assert_eq!(agent_type_of(&json!({"prompt": "p"})), "general-purpose");
        assert_eq!(
            agent_type_of(&json!({"subagent_type": "fable52"})),
            "fable52"
        );
    }

    #[test]
    fn a_single_spawn_goes_at_once() {
        let root = tmp("single");
        let transcript = root.join("s.jsonl");
        let t0 = std::time::Instant::now();
        let note = hold(
            &root,
            Some(&transcript),
            "",
            &json!({"prompt": "p"}),
            Some("opus"),
            "t1",
            1_000,
            2_000,
            10,
        );
        assert!(note.is_none());
        assert!(t0.elapsed().as_millis() < 100);
        // No transcript: nothing to watch, no group either.
        assert!(hold(&root, None, "", &json!({}), None, "t9", 1_000, 2_000, 10).is_none());
    }

    #[test]
    fn a_later_spawn_waits_for_the_first_reply_then_others_go() {
        let root = tmp("follow");
        let transcript = root.join("s.jsonl");
        let agents = subagents_dir(&transcript);
        std::fs::create_dir_all(&agents).unwrap();
        // An older helper's file is there already: it does not count.
        std::fs::write(
            agents.join("agent-old.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5-5\"}}\n",
        )
        .unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let input = json!({"subagent_type": "reusable", "prompt": "p"});
        assert!(
            hold(
                &root,
                Some(&transcript),
                "",
                &input,
                Some("opus"),
                "t1",
                now,
                5_000,
                10
            )
            .is_none()
        );
        let a = agents.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            std::fs::write(
                a.join("agent-new.meta.json"),
                "{\"agentType\":\"reusable\"}",
            )
            .unwrap();
            std::fs::write(a.join("agent-new.jsonl"), "{\"type\":\"user\"}\n").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            std::fs::write(
                a.join("agent-new.jsonl"),
                "{\"type\":\"user\"}\n{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5-5\"}}\n",
            )
            .unwrap();
        });
        let t0 = std::time::Instant::now();
        let note = hold(
            &root,
            Some(&transcript),
            "",
            &input,
            Some("opus"),
            "t2",
            now + 5,
            5_000,
            10,
        )
        .unwrap();
        let waited = t0.elapsed().as_millis();
        writer.join().unwrap();
        assert!((200..2_000).contains(&waited), "waited {waited} ms");
        assert!(note.contains("reads that helper's cached prompt"), "{note}");
        assert!(read_held(&root).is_empty());
        // The third goes at once now.
        let t1 = std::time::Instant::now();
        assert!(
            hold(
                &root,
                Some(&transcript),
                "",
                &input,
                Some("opus"),
                "t3",
                now + 10,
                5_000,
                10
            )
            .is_none()
        );
        assert!(t1.elapsed().as_millis() < 100);
        // Another type leads its own group, no wait.
        let other = json!({"subagent_type": "general-purpose"});
        assert!(
            hold(
                &root,
                Some(&transcript),
                "",
                &other,
                Some("opus"),
                "t4",
                now + 10,
                5_000,
                10
            )
            .is_none()
        );
    }

    #[test]
    fn a_slow_first_holds_the_others_only_to_the_timeout() {
        let root = tmp("slow");
        let transcript = root.join("s.jsonl");
        let now = chrono::Utc::now().timestamp_millis();
        let input = json!({"prompt": "p"});
        assert!(
            hold(
                &root,
                Some(&transcript),
                "",
                &input,
                None,
                "t1",
                now,
                300,
                10
            )
            .is_none()
        );
        let t0 = std::time::Instant::now();
        let note = hold(
            &root,
            Some(&transcript),
            "",
            &input,
            None,
            "t2",
            now,
            300,
            10,
        )
        .unwrap();
        assert!(t0.elapsed().as_millis() < 1_000);
        assert!(note.contains("did not come in time"), "{note}");
    }

    #[test]
    fn only_the_leaders_own_reply_releases_when_its_meta_names_the_call() {
        let dir = tmp("leader");
        let reply = "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5-5\"}}\n";
        // A same-type helper of another group answered: not the leader.
        std::fs::write(
            dir.join("agent-x.meta.json"),
            "{\"agentType\":\"reusable\",\"toolUseId\":\"toolu_other\"}",
        )
        .unwrap();
        std::fs::write(dir.join("agent-x.jsonl"), reply).unwrap();
        assert!(!first_reply_in(&dir, &[], "toolu_lead", "reusable", Some("opus")));
        // The leader's own reply counts.
        std::fs::write(
            dir.join("agent-y.meta.json"),
            "{\"agentType\":\"reusable\",\"toolUseId\":\"toolu_lead\"}",
        )
        .unwrap();
        std::fs::write(dir.join("agent-y.jsonl"), reply).unwrap();
        assert!(first_reply_in(&dir, &[], "toolu_lead", "reusable", Some("opus")));
    }

    #[test]
    fn a_held_entry_left_by_a_dead_hook_ages_out() {
        let dir = tmp("stale");
        let now = chrono::Utc::now().timestamp_millis();
        let old = Held {
            text: "x".into(),
            since_ms: now - HELD_STALE_MS - 1,
        };
        let mut m = BTreeMap::new();
        m.insert("dead".to_string(), old);
        std::fs::write(dir.join(HELD_FILE), serde_json::to_string(&m).unwrap()).unwrap();
        assert!(read_held(&dir).is_empty());
        set_held(
            &dir,
            "live",
            Some(Held {
                text: "y".into(),
                since_ms: now,
            }),
        );
        let on_disk: BTreeMap<String, Held> =
            serde_json::from_str(&std::fs::read_to_string(dir.join(HELD_FILE)).unwrap()).unwrap();
        assert_eq!(on_disk.keys().collect::<Vec<_>>(), vec!["live"]);
    }
}
