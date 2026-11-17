//! One every-chat rule set for the Mac and the away server (nightshift item
//! 783, blocker 2028: "what's the point of having rules that are separate
//! on Mac versus away server?").
//!
//! Each host still keeps its own `approval-rules.json` in its config
//! directory — the hook reads it on every call and must not wait on a
//! network — and the Mac's sync pass (the one that carries chats,
//! `away.rs`) makes the two files say the same thing:
//!
//! 1. the Mac reads the away server's set (`GET /api/sync/rules`) and its
//!    own, and the set both agreed on at the last sync
//!    ([`BASE_FILE`], on the Mac only);
//! 2. [`merge`] is a three-way merge by rule id: a rule added, changed or
//!    removed on one side since the last sync is taken; a rule **both**
//!    changed differently is **kept twice** and a note says so (a rule one
//!    removed and the other changed is kept as changed, and noted);
//! 3. the merged set is written to the server (`PUT`, refused with 409 if
//!    the server's set changed meanwhile — a rule made on the phone that
//!    second — and the pass tries once more), then to the Mac, then kept
//!    as the next sync's base.
//!
//! **Ids.** Before this an every-chat rule's id was `a<n>` per host, so
//! `a1` on the Mac and `a1` on the away server were different rules.
//! [`migrated`] gives each such rule an id of its own (`a-<uuid>`) the
//! first time the file is listed or synced; with no base, the first sync
//! is then the union of the two hosts' rules, the same rule on both
//! (action, tool and text equal) kept once. A chat's own rules stay with
//! the chat.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{Rule, Store, read, write};

/// The set both hosts agreed on at the last sync, beside the Mac's rules.
pub const BASE_FILE: &str = "approval-rules.synced.json";

/// The every-chat set as it travels: the rules and the connector tools
/// allowed for good in read-only chats.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shared {
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub reads: Vec<String>,
}

/// A host's set and the revision it was read at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Held {
    #[serde(flatten)]
    pub shared: Shared,
    /// A hash of the set: a `put` names the one it read.
    pub rev: String,
}

/// `PUT /api/sync/rules`'s body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Put {
    #[serde(flatten)]
    pub shared: Shared,
    /// The revision the sender merged against.
    pub rev: String,
    /// What the merge had to say, for this host's list too.
    #[serde(default)]
    pub notes: Vec<String>,
}

/// What [`put`] answers when the set changed since `rev` was read.
pub const CHANGED: &str = "the rules changed while they were being synced";

/// A new every-chat rule's id.
pub fn new_id() -> String {
    format!("a-{}", uuid::Uuid::new_v4().simple())
}

fn rev_of(shared: &Shared) -> String {
    crate::sync::manifest::sha256_hex(&serde_json::to_vec(shared).unwrap_or_default())
}

/// The every-chat store in `dir`, its per-host ids (`a<n>`) replaced by
/// ids of their own. Written back only when something changed.
pub(crate) fn migrated(dir: &Path) -> Store {
    let mut store = read(dir);
    let mut changed = false;
    for rule in &mut store.rules {
        if !rule.id.starts_with("a-") {
            rule.id = new_id();
            changed = true;
        }
    }
    if changed {
        let _ = write(dir, &store);
    }
    store
}

/// This host's set.
pub fn get(dir: &Path) -> Held {
    let store = migrated(dir);
    let shared = Shared {
        rules: store.rules,
        reads: store.reads,
    };
    Held {
        rev: rev_of(&shared),
        shared,
    }
}

/// Replace this host's set with `new`, if it is still at `rev`.
pub fn put(dir: &Path, new: &Put) -> Result<Held, String> {
    let mut store = migrated(dir);
    let now = Shared {
        rules: std::mem::take(&mut store.rules),
        reads: std::mem::take(&mut store.reads),
    };
    if rev_of(&now) != new.rev {
        return Err(CHANGED.into());
    }
    store.rules = new.shared.rules.clone();
    store.reads = new.shared.reads.clone();
    for note in &new.notes {
        if !store.notes.contains(note) {
            store.notes.push(note.clone());
        }
    }
    write(dir, &store)?;
    Ok(get(dir))
}

fn same(a: &Rule, b: &Rule) -> bool {
    a.action == b.action && a.tool == b.tool && a.text == b.text
}

fn find<'a>(set: &'a Shared, id: &str) -> Option<&'a Rule> {
    set.rules.iter().find(|r| r.id == id)
}

/// The three-way merge: `base` is what both had at the last sync (empty
/// the first time), `mac` and `away` what each has now. Returns the set
/// both get and what he should be told.
pub fn merge(base: &Shared, mac: &Shared, away: &Shared) -> (Shared, Vec<String>) {
    let mut out: Vec<Rule> = Vec::new();
    let mut notes = Vec::new();
    let mut ids: Vec<&str> = Vec::new();
    for r in mac.rules.iter().chain(&away.rules).chain(&base.rules) {
        if !ids.contains(&r.id.as_str()) {
            ids.push(&r.id);
        }
    }
    for id in ids {
        let (b, m, a) = (find(base, id), find(mac, id), find(away, id));
        let unchanged = |side: Option<&Rule>| match (side, b) {
            (Some(s), Some(b)) => same(s, b),
            (None, None) => true,
            _ => false,
        };
        match (m, a) {
            (None, None) => {}
            (Some(m), Some(a)) if same(m, a) => out.push(m.clone()),
            // One side left it as it was: the other's word stands, a
            // removal included.
            (m, a) if unchanged(m) => out.extend(a.cloned()),
            (m, a) if unchanged(a) => out.extend(m.cloned()),
            // Both changed it, differently: both are kept.
            (Some(m), Some(a)) => {
                out.push(a.clone());
                out.push(Rule {
                    id: new_id(),
                    ..m.clone()
                });
                notes.push(format!(
                    "A rule was changed on both the Mac and the away server before they synced, so both versions were kept: {} {} (away server) and {} {} (Mac). Remove the one you do not want.",
                    word(a),
                    super::describe(a),
                    word(m),
                    super::describe(m),
                ));
            }
            // One removed it, the other changed it: the change is kept.
            (Some(kept), None) | (None, Some(kept)) => {
                out.push(kept.clone());
                notes.push(format!(
                    "A rule was removed on one of the Mac and the away server and changed on the other before they synced, so the changed one was kept: {} {}. Remove it again if you meant to.",
                    word(kept),
                    super::describe(kept),
                ));
            }
        }
    }
    // The same rule made on both is one rule.
    let mut rules: Vec<Rule> = Vec::new();
    for r in out {
        if !rules.iter().any(|k| same(k, &r)) {
            rules.push(r);
        }
    }
    let mut reads: Vec<String> = Vec::new();
    for t in mac.reads.iter().chain(&away.reads) {
        let (in_b, in_m, in_a) = (
            base.reads.contains(t),
            mac.reads.contains(t),
            away.reads.contains(t),
        );
        // Kept unless one side took it off since the last sync.
        if ((in_m && in_a) || !in_b) && !reads.contains(t) {
            reads.push(t.clone());
        }
    }
    (Shared { rules, reads }, notes)
}

fn word(rule: &Rule) -> &'static str {
    match rule.action {
        super::Action::Allow => "Allow",
        super::Action::Ask => "Ask",
        super::Action::Block => "Block",
    }
}

fn read_base(config: &Path) -> Shared {
    std::fs::read(config.join(BASE_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_base(config: &Path, shared: &Shared) -> Result<(), String> {
    let tmp = config.join(format!("{BASE_FILE}.tmp"));
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(shared).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, config.join(BASE_FILE)).map_err(|e| e.to_string())
}

/// What one sync did, for the pass's summary line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Synced {
    /// Rules and allowed reads in the set both hosts now hold.
    pub rules: usize,
    /// Notes left for him (a rule both changed).
    pub notes: usize,
}

/// The other host, as [`sync`] needs it: its set, and replacing it.
#[async_trait::async_trait]
pub trait Peer: Sync {
    async fn get(&self) -> Result<Held, String>;
    /// `Ok(false)` when the peer's set changed since `put.rev`.
    async fn put(&self, put: &Put) -> Result<bool, String>;
}

#[async_trait::async_trait]
impl Peer for crate::sync::Client {
    async fn get(&self) -> Result<Held, String> {
        self.get_json("rules").await
    }
    async fn put(&self, put: &Put) -> Result<bool, String> {
        self.put_rules(put).await
    }
}

/// The Mac's half of one sync: merge its set in `config` with `peer`'s and
/// leave both holding the result. An edit made on either host while this
/// runs is not lost: the peer refuses a stale write (one more try), and a
/// Mac file that changed meanwhile is left for the next pass, base
/// untouched.
pub async fn sync(peer: &dyn Peer, config: &Path) -> Result<Synced, String> {
    for _ in 0..2 {
        let theirs = peer.get().await?;
        let mine = get(config);
        let base = read_base(config);
        let (merged, notes) = merge(&base, &mine.shared, &theirs.shared);
        if merged != theirs.shared || !notes.is_empty() {
            let sent = peer
                .put(&Put {
                    shared: merged.clone(),
                    rev: theirs.rev.clone(),
                    notes: notes.clone(),
                })
                .await?;
            if !sent {
                continue;
            }
        }
        if merged != mine.shared || !notes.is_empty() {
            match put(
                config,
                &Put {
                    shared: merged.clone(),
                    rev: mine.rev.clone(),
                    notes: notes.clone(),
                },
            ) {
                Ok(_) => {}
                // He changed a rule on the Mac this very moment: the next
                // pass merges it, against the old base.
                Err(e) if e == CHANGED => {
                    return Ok(Synced {
                        rules: merged.rules.len() + merged.reads.len(),
                        notes: 0,
                    });
                }
                Err(e) => return Err(e),
            }
        }
        if merged != base {
            write_base(config, &merged)?;
        }
        return Ok(Synced {
            rules: merged.rules.len() + merged.reads.len(),
            notes: notes.len(),
        });
    }
    Err("the away server's rules kept changing; they sync on the next pass".into())
}

#[cfg(test)]
mod tests {
    use super::super::{Action, Edit, Places, edit, list};
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn root() -> Root {
        let r = std::env::temp_dir().join(format!("nightloom-shared-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(r.join("mac")).unwrap();
        std::fs::create_dir_all(r.join("away")).unwrap();
        Root(r)
    }

    fn all(dir: &Path) -> Places {
        Places {
            all: Some(dir.to_path_buf()),
            chat: None,
        }
    }

    fn add(dir: &Path, action: &str, tool: &str, text: &str) {
        edit(
            &all(dir),
            Edit::Add {
                scope: "all".into(),
                action: action.into(),
                tool: tool.into(),
                text: text.into(),
            },
        )
        .unwrap();
    }

    /// The away server as a folder: what its two routes do.
    struct Folder(PathBuf, Mutex<u32>);

    #[async_trait::async_trait]
    impl Peer for Folder {
        async fn get(&self) -> Result<Held, String> {
            Ok(get(&self.0))
        }
        async fn put(&self, p: &Put) -> Result<bool, String> {
            *self.1.lock().unwrap() += 1;
            match put(&self.0, p) {
                Ok(_) => Ok(true),
                Err(e) if e == CHANGED => Ok(false),
                Err(e) => Err(e),
            }
        }
    }

    fn texts(dir: &Path) -> Vec<String> {
        let mut t: Vec<String> = list(&all(dir))
            .rules
            .into_iter()
            .map(|r| format!("{:?} {} {} {}", r.action, r.tool, r.text, r.source))
            .collect();
        t.sort();
        t
    }

    #[tokio::test]
    async fn todays_per_host_rules_become_one_set_and_the_same_rule_is_kept_once() {
        let r = root();
        let (mac, away) = (r.0.join("mac"), r.0.join("away"));
        // As the files are today: per-host ids, `a1` on both, different rules.
        let old = |rules: serde_json::Value| serde_json::json!({ "rules": rules, "next": 2 });
        std::fs::write(
            mac.join(super::super::FILE),
            old(serde_json::json!([
                { "id": "a1", "action": "block", "tool": "Bash", "text": "rm -rf" },
                { "id": "a2", "action": "allow", "tool": "WebSearch" },
            ]))
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            away.join(super::super::FILE),
            old(serde_json::json!([
                { "id": "a1", "action": "ask", "tool": "Bash", "text": "git push" },
                { "id": "a2", "action": "allow", "tool": "WebSearch" },
            ]))
            .to_string(),
        )
        .unwrap();
        let peer = Folder(away.clone(), Mutex::new(0));
        let done = sync(&peer, &mac).await.unwrap();
        assert_eq!(done, Synced { rules: 3, notes: 0 });
        assert_eq!(texts(&mac), texts(&away));
        assert_eq!(
            texts(&mac),
            [
                "Allow WebSearch  rule",
                "Ask Bash git push rule",
                "Block Bash rm -rf rule"
            ]
        );
        // Ids are the same on both hosts now, and none is a per-host one.
        let ids = |d: &Path| {
            let mut v: Vec<String> = get(d).shared.rules.into_iter().map(|r| r.id).collect();
            v.sort();
            v
        };
        assert_eq!(ids(&mac), ids(&away));
        assert!(ids(&mac).iter().all(|i| i.starts_with("a-")));
        // A second pass with nothing changed writes nothing to the server.
        let puts = *peer.1.lock().unwrap();
        sync(&peer, &mac).await.unwrap();
        assert_eq!(*peer.1.lock().unwrap(), puts);
    }

    #[tokio::test]
    async fn adds_changes_and_removals_travel_both_ways() {
        let r = root();
        let (mac, away) = (r.0.join("mac"), r.0.join("away"));
        let peer = Folder(away.clone(), Mutex::new(0));
        add(&mac, "block", "Bash", "rm -rf");
        add(&away, "allow", "WebFetch", "docs.rs");
        super::super::allow_read(&away, "mcp__x__inspect_thing").unwrap();
        sync(&peer, &mac).await.unwrap();
        assert_eq!(texts(&mac).len(), 3);
        assert_eq!(texts(&mac), texts(&away));
        // Removed on the Mac, changed on away (a different rule), the read
        // taken off on the Mac.
        let id_of = |d: &Path, tool: &str| {
            get(d)
                .shared
                .rules
                .into_iter()
                .find(|r| r.tool == tool)
                .unwrap()
                .id
        };
        edit(
            &all(&mac),
            Edit::Remove {
                id: id_of(&mac, "Bash"),
            },
        )
        .unwrap();
        edit(
            &all(&mac),
            Edit::Remove {
                id: "read:mcp__x__inspect_thing".into(),
            },
        )
        .unwrap();
        edit(
            &all(&away),
            Edit::Change {
                id: id_of(&away, "WebFetch"),
                action: "ask".into(),
                tool: "WebFetch".into(),
                text: "docs.rs".into(),
            },
        )
        .unwrap();
        let done = sync(&peer, &mac).await.unwrap();
        assert_eq!(done.notes, 0);
        assert_eq!(texts(&mac), ["Ask WebFetch docs.rs rule"]);
        assert_eq!(texts(&away), texts(&mac));
    }

    #[tokio::test]
    async fn a_rule_changed_on_both_is_kept_twice_and_said() {
        let r = root();
        let (mac, away) = (r.0.join("mac"), r.0.join("away"));
        let peer = Folder(away.clone(), Mutex::new(0));
        add(&mac, "ask", "Bash", "git push");
        sync(&peer, &mac).await.unwrap();
        let id = get(&mac).shared.rules[0].id.clone();
        let change = |d: &Path, action: &str| {
            edit(
                &all(d),
                Edit::Change {
                    id: id.clone(),
                    action: action.into(),
                    tool: "Bash".into(),
                    text: "git push".into(),
                },
            )
            .unwrap();
        };
        change(&mac, "allow");
        change(&away, "block");
        let done = sync(&peer, &mac).await.unwrap();
        assert_eq!(done, Synced { rules: 2, notes: 1 });
        for d in [&mac, &away] {
            let l = list(&all(d));
            let mut actions: Vec<Action> = l.rules.iter().map(|r| r.action).collect();
            actions.sort_by_key(|a| *a as u8);
            assert_eq!(actions, [Action::Allow, Action::Block]);
            assert_eq!(l.notes.len(), 1);
            assert!(
                l.notes[0].contains("both versions were kept"),
                "{}",
                l.notes[0]
            );
        }
        // The block decides meanwhile (block before allow), and the note
        // goes when he has read it.
        let after = edit(&all(&mac), Edit::Dismiss).unwrap();
        assert!(after.notes.is_empty());
        // Removed on one, changed on the other: the change is kept, said.
        let (base, m, a) = (
            Shared {
                rules: vec![Rule {
                    id: "a-1".into(),
                    action: Action::Ask,
                    tool: "Write".into(),
                    text: String::new(),
                }],
                reads: vec![],
            },
            Shared::default(),
            Shared {
                rules: vec![Rule {
                    id: "a-1".into(),
                    action: Action::Block,
                    tool: "Write".into(),
                    text: String::new(),
                }],
                reads: vec![],
            },
        );
        let (merged, notes) = merge(&base, &m, &a);
        assert_eq!(merged.rules, a.rules);
        assert_eq!(notes.len(), 1);
    }

    #[tokio::test]
    async fn a_rule_made_on_the_server_during_the_sync_is_not_overwritten() {
        let r = root();
        let (mac, away) = (r.0.join("mac"), r.0.join("away"));
        add(&mac, "block", "Bash", "rm -rf");
        // A stale revision is refused, nothing written.
        let stale = get(&away).rev;
        add(&away, "ask", "Write", "");
        let refused = put(
            &away,
            &Put {
                shared: get(&mac).shared,
                rev: stale,
                notes: vec![],
            },
        );
        assert_eq!(refused.unwrap_err(), CHANGED);
        assert_eq!(texts(&away), ["Ask Write  rule"]);
        // And the pass as a whole ends with both rules on both hosts.
        sync(&Folder(away.clone(), Mutex::new(0)), &mac)
            .await
            .unwrap();
        assert_eq!(texts(&mac).len(), 2);
        assert_eq!(texts(&mac), texts(&away));
    }
}
