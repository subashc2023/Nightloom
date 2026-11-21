//! A Bitwarden "always" rule, enforced where the command runs (nightshift
//! item 825, 2026-11-17). Part 2 of item 766 answered a `request_secret`
//! by a rule from the `command` the model *declared*, and wrote the value
//! into the file the model reads at once — so any command of the chat could
//! read it for a day, and a prefix like `bash` covered every command.
//!
//! Now a rule's answer is **held** ([`super::Store::hold`]): the value
//! waits in a copy the model is not told of, and the chat's folder keeps a
//! note ([`HeldNote`]: the two paths and the rule's words, never the value).
//! Nightloom's own `PreToolUse` hook — the brief hook, which runs on every
//! call of every process in the turn — asks [`release_gate`] first:
//!
//! - every call starts by taking back a copy an earlier call was given
//!   ([`rehold`]), as do the card loop and the turn's end;
//! - a call that names the file, the held copy or the note is refused,
//!   unless it is the main chat's shell command that runs the rule's words
//!   ([`runs_rule`]): one plain command — no `;`, `&`, `|`, parentheses,
//!   backticks or other `$(` — whose program words start with the rule's
//!   prefix word for word, whose program is no wrapper
//!   ([`crate::bitwarden::is_wrapper`]), reading the file only as
//!   `"$(cat '<path>')"`, with no assignment in front but one of the value
//!   itself (`NAME="$(cat '<path>')" gh …`), in the foreground;
//! - that command gets the value copied into the file just before it runs
//!   ([`release`]).
//!
//! What is *not* stopped, said plainly: a command that reaches the file by
//! a name the gate cannot read (built at run time, encoded), run in the
//! same moment as the released command; a program the shell finds first on
//! `PATH` under the rule's name. Both need the model to work against him on
//! purpose; the gate stops every road that names the file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{HELD_DIR, HELD_FILE};

/// One held value's note, in [`HELD_FILE`] under its name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeldNote {
    /// The file the model is told to read; empty until a release.
    pub path: PathBuf,
    /// Where the value waits ([`super::Store::held_path`]).
    pub held: PathBuf,
    /// The rule's words ([`crate::bitwarden::Rule::prefix`]).
    pub prefix: String,
}

fn read_held(chat_dir: &Path) -> BTreeMap<String, HeldNote> {
    std::fs::read(chat_dir.join(HELD_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_held(chat_dir: &Path, map: &BTreeMap<String, HeldNote>) -> std::io::Result<()> {
    let at = chat_dir.join(HELD_FILE);
    if map.is_empty() {
        return match std::fs::remove_file(&at) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(chat_dir)?;
    let tmp = chat_dir.join(format!("{HELD_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, serde_json::to_vec(map)?)?;
    std::fs::rename(tmp, at)
}

/// The turn's note, once a rule's value for `name` is held: the tool says
/// where it will appear, and the hook knows what to release it to. A value
/// he gave on the card for the same name before is no longer the answer.
pub fn note_held(chat_dir: &Path, name: &str, note: &HeldNote) -> std::io::Result<()> {
    super::unnote_stored(chat_dir, name)?;
    let mut map = read_held(chat_dir);
    map.insert(name.to_string(), note.clone());
    write_held(chat_dir, &map)
}

/// Drop `name`'s held note (a value he gave on the card replaces it).
pub fn forget_held(chat_dir: &Path, name: &str) -> std::io::Result<()> {
    let mut map = read_held(chat_dir);
    if map.remove(name).is_some() {
        write_held(chat_dir, &map)?;
    }
    Ok(())
}

/// `name`'s held note, while its held copy is there.
pub fn held_note(chat_dir: &Path, name: &str) -> Option<HeldNote> {
    read_held(chat_dir)
        .remove(name)
        .filter(|n| n.held.is_file())
}

/// Take back every copy a call was given: the file the model reads is
/// removed wherever it holds exactly the held value. A note whose held copy
/// is gone (past its day) is dropped. Best-effort, quick when there is
/// nothing held (one failed read).
pub fn rehold(chat_dir: &Path) {
    let map = read_held(chat_dir);
    if map.is_empty() {
        return;
    }
    let mut kept = map.clone();
    for (name, note) in &map {
        match std::fs::read(&note.held) {
            Ok(held) => {
                if std::fs::read(&note.path).is_ok_and(|out| out == held) {
                    let _ = std::fs::remove_file(&note.path);
                }
            }
            Err(_) => {
                kept.remove(name);
            }
        }
    }
    if kept.len() != map.len() {
        let _ = write_held(chat_dir, &kept);
    }
}

/// Copy the held value into the file the model reads, `0600`, whole or not
/// at all. Never says the value in an error.
pub fn release(note: &HeldNote) -> std::io::Result<()> {
    let value = std::fs::read(&note.held)?;
    let dir = note
        .path
        .parent()
        .ok_or_else(|| std::io::Error::other("no folder"))?;
    let tmp = dir.join(format!(".release.{}", uuid::Uuid::new_v4()));
    super::write_private(&tmp, &value)
        .and_then(|_| std::fs::rename(&tmp, &note.path))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
}

/// What the hook does with one call.
#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    /// Nothing held is named: the call goes on as it would.
    Pass,
    /// Refused, with the reason the model reads.
    Deny(String),
    /// The call runs the rule's words: release these just before it runs.
    Release(Vec<HeldNote>),
}

/// Whether `text` names `note`'s file, its held copy, a held folder or the
/// note itself.
fn names(text: &str, note: &HeldNote) -> bool {
    let path = note.path.to_string_lossy();
    let held = note.held.to_string_lossy();
    (!path.is_empty() && text.contains(path.as_ref()))
        || (!held.is_empty() && text.contains(held.as_ref()))
        || text.contains(HELD_DIR)
        || text.contains(HELD_FILE)
}

/// Every string in `v` (keys and values), unescaped, one per line.
fn strings_in(v: &Value, out: &mut String) {
    match v {
        Value::String(s) => {
            out.push_str(s);
            out.push('\n');
        }
        Value::Array(items) => items.iter().for_each(|i| strings_in(i, out)),
        Value::Object(map) => {
            for (k, i) in map {
                out.push_str(k);
                out.push('\n');
                strings_in(i, out);
            }
        }
        _ => {}
    }
}

/// The words every refusal ends with: what would be released.
fn how(name: &str, note: &HeldNote) -> String {
    format!(
        "{name} (from Bitwarden, allowed always for `{}`) is released only to one plain shell command of the main chat that starts `{} …` and reads it as \"$(cat '{}')\" — no wrapper, pipe, `;`, `&&`, subshell or background run.",
        note.prefix,
        note.prefix,
        note.path.display()
    )
}

/// The hook's check of one call against the chat's held values (item 825).
/// `main` is false on a subagent's call. Call [`rehold`] first.
pub fn release_gate(chat_dir: &Path, tool_name: &str, tool_input: &Value, main: bool) -> Gate {
    let held = read_held(chat_dir);
    if held.is_empty() {
        return Gate::Pass;
    }
    let text = match tool_input {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    };
    // Serialized JSON escapes `"` and `\`; look at the raw command too.
    let command = tool_input
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // And at every string as written: a Windows path's `\` is doubled in
    // the JSON, so a Read of the file passed there (item 864).
    let mut raw = String::new();
    strings_in(tool_input, &mut raw);
    let named: Vec<(&String, &HeldNote)> = held
        .iter()
        .filter(|(_, n)| names(&text, n) || names(command, n) || names(&raw, n))
        .collect();
    if named.is_empty() {
        return Gate::Pass;
    }
    let mut out = Vec::new();
    for (name, note) in named {
        if tool_name != "Bash" {
            return Gate::Deny(format!(
                "Not run: no tool but the shell may name this file. {}",
                how(name, note)
            ));
        }
        if !main {
            return Gate::Deny(format!(
                "Not run: a helper's command never gets it, only the main chat's. {}",
                how(name, note)
            ));
        }
        if tool_input
            .get("run_in_background")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Gate::Deny(format!(
                "Not run: run it in the foreground. {}",
                how(name, note)
            ));
        }
        if let Err(why) = runs_rule(command, note) {
            return Gate::Deny(format!("Not run: {why}. {}", how(name, note)));
        }
        out.push(note.clone());
    }
    Gate::Release(out)
}

/// The word the allowed reads of the file become while the command is
/// read: a plain word no command holds by chance.
const MARK: &str = "NIGHTLOOM_SECRET_825";

/// Whether `command`, as the shell will run it, runs `note`'s rule: `Ok`
/// only for one plain command whose program words start with the rule's
/// prefix, word for word. The reason, in a few words, otherwise.
pub fn runs_rule(command: &str, note: &HeldNote) -> Result<(), String> {
    let p = note.path.to_string_lossy();
    // The allowed reads, longest first, each a word of its own.
    let forms = [
        format!("\"$(cat '{p}')\""),
        format!("\"$(cat \"{p}\")\""),
        format!("$(cat '{p}')"),
        format!("$(cat \"{p}\")"),
        format!("$(cat {p})"),
    ];
    let mut rest = command.to_string();
    let mut reads = 0;
    for f in &forms {
        reads += rest.matches(f.as_str()).count();
        rest = rest.replace(f.as_str(), MARK);
    }
    if reads == 0 {
        return Err("it does not read the file as \"$(cat '<path>')\"".into());
    }
    if names(&rest, note) {
        return Err("it reaches the file another way too".into());
    }
    let words = shell_words(&rest)?;
    let mut i = 0;
    while let Some(w) = words.get(i) {
        let Some((var, value)) = w.split_once('=') else {
            break;
        };
        let is_var = var
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && var.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !is_var {
            break;
        }
        if value != MARK {
            return Err(format!(
                "`{var}=` in front sets something other than the value"
            ));
        }
        i += 1;
    }
    let program = &words[i..];
    let Some(first) = program.first() else {
        return Err("it runs no program".into());
    };
    if crate::bitwarden::is_wrapper(first) {
        return Err(format!("`{first}` runs another command"));
    }
    if !crate::bitwarden::prefix_matches(&note.prefix, &program.join(" ")) {
        return Err(format!(
            "it runs `{}`, not `{}`",
            program_head(program),
            note.prefix
        ));
    }
    Ok(())
}

/// A command's first words, for a refusal (never the value: the reads are
/// [`MARK`] by now).
fn program_head(program: &[String]) -> String {
    program
        .iter()
        .take(3)
        .map(|w| if w.contains(MARK) { "…" } else { w.as_str() })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The shell's words of one plain command, quotes removed. Refuses what
/// would run a second command or hide one: an unquoted `;`, `&` (but a
/// redirection's `>&`), `|`, `(`, `)` or line break, a backtick or `$(`
/// outside single quotes, and an unclosed quote.
pub fn shell_words(command: &str) -> Result<Vec<String>, String> {
    #[derive(PartialEq)]
    enum Q {
        None,
        Single,
        Double,
    }
    let refuse = |what: &str| Err(format!("it is not one plain command ({what})"));
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut q = Q::None;
    let mut prev: Option<char> = None;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match q {
            Q::Single => {
                if c == '\'' {
                    q = Q::None;
                } else {
                    word.push(c);
                }
            }
            Q::Double => match c {
                '"' => q = Q::None,
                '`' => return refuse("a backtick"),
                '$' if chars.peek() == Some(&'(') => return refuse("`$(`"),
                '\\' => {
                    if let Some(n) = chars.next() {
                        word.push(n);
                    }
                }
                _ => word.push(c),
            },
            Q::None => match c {
                c if c == ' ' || c == '\t' => {
                    if in_word {
                        words.push(std::mem::take(&mut word));
                        in_word = false;
                    }
                }
                '\'' => {
                    q = Q::Single;
                    in_word = true;
                }
                '"' => {
                    q = Q::Double;
                    in_word = true;
                }
                '\\' => match chars.next() {
                    Some('\n') | None => return refuse("a line break"),
                    Some(n) => {
                        word.push(n);
                        in_word = true;
                    }
                },
                ';' => return refuse("`;`"),
                '|' => return refuse("a pipe"),
                '&' if matches!(prev, Some('>') | Some('<')) => {
                    word.push(c);
                    in_word = true;
                }
                '&' => return refuse("`&`"),
                '(' | ')' => return refuse("a subshell"),
                '\n' | '\r' => return refuse("a line break"),
                '`' => return refuse("a backtick"),
                '$' if chars.peek() == Some(&'(') => return refuse("`$(`"),
                _ => {
                    word.push(c);
                    in_word = true;
                }
            },
        }
        prev = Some(c);
    }
    if q != Q::None {
        return refuse("an open quote");
    }
    if in_word {
        words.push(word);
    }
    Ok(words)
}

#[cfg(test)]
#[path = "secret_release_825_tests.rs"]
mod tests;
