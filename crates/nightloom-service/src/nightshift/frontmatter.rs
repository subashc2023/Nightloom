//! The frontmatter subset `bin/shiftctl.py` reads and writes, ported rule for
//! rule.
//!
//! The runner's reference implementation is a deliberately small YAML subset:
//! `key: value` lines between two `---` lines, values are strings, surrounding
//! quotes are stripped, nothing nests. This file has to agree with
//! `shiftctl.py::split_frontmatter` byte for byte, because both sides read the
//! same item and blocker files and a disagreement over `id: "017"` versus
//! `id: 017` is a GUI that cannot find an item the runner just worked on. Do
//! not reach for a YAML crate here: it would accept more than the runner
//! does, and the two would drift on exactly the inputs a real parser is
//! lenient about.

use regex::Regex;
use std::sync::LazyLock;

/// `^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$` in shiftctl; a line that does not
/// match is kept verbatim and contributes no field.
static FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$").expect("field regex"));
/// The key half alone, which is what `set_frontmatter` matches on.
static KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_][A-Za-z0-9_-]*):").expect("key regex"));

/// A file split into its fields, the raw frontmatter lines and the body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Split {
    /// In file order. A key that appears twice is listed twice; [`Split::get`]
    /// returns the last, which is what a Python dict built in a loop holds.
    pub fields: Vec<(String, String)>,
    /// The lines between the two `---`, untouched, so a rewrite preserves
    /// comments and order.
    pub raw: Vec<String>,
    /// Everything after the closing `---`. The whole text when there is no
    /// frontmatter.
    pub body: String,
}

impl Split {
    /// The last value written for `key`, or `None`.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// `get`, with a missing or empty value reading as `None` — shiftctl's
    /// `item_field` treats `""` as absent so the project default applies.
    pub fn get_nonempty(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|v| !v.is_empty())
    }
}

/// `-> (fields, raw_frontmatter_lines, body)`. Body starts after the closing
/// `---`. No opening `---` on the first line, or no closing one anywhere,
/// means no frontmatter and the whole text is body.
pub fn split(text: &str) -> Split {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.is_empty() || lines[0].trim() != "---" {
        return Split {
            body: text.to_string(),
            ..Default::default()
        };
    }
    for i in 1..lines.len() {
        if lines[i].trim() != "---" {
            continue;
        }
        let raw: Vec<String> = lines[1..i].iter().map(|s| s.to_string()).collect();
        let body = lines[i + 1..].join("\n");
        let mut fields = Vec::new();
        for ln in &raw {
            if let Some(m) = FIELD.captures(ln) {
                let mut v = m[2].trim();
                let bytes = v.as_bytes();
                if bytes.len() >= 2
                    && bytes[0] == bytes[bytes.len() - 1]
                    && (bytes[0] == b'"' || bytes[0] == b'\'')
                {
                    v = &v[1..v.len() - 1];
                }
                fields.push((m[1].to_string(), v.to_string()));
            }
        }
        return Split { fields, raw, body };
    }
    Split {
        body: text.to_string(),
        ..Default::default()
    }
}

/// Set one key in place, preserving order; append it if absent. A text with
/// no frontmatter gains one holding just this key.
pub fn set(text: &str, key: &str, value: &str) -> String {
    let s = split(text);
    let mut out: Vec<String> = Vec::with_capacity(s.raw.len() + 1);
    let mut done = false;
    for ln in &s.raw {
        match KEY.captures(ln) {
            Some(m) if &m[1] == key => {
                out.push(format!("{key}: {value}"));
                done = true;
            }
            _ => out.push(ln.clone()),
        }
    }
    if !done {
        out.push(format!("{key}: {value}"));
    }
    format!("---\n{}\n---\n{}", out.join("\n"), s.body)
}

/// Text under `## <title>` up to the next `## `, trimmed. Empty when the
/// section is absent.
pub fn section(body: &str, title: &str) -> String {
    let heading =
        Regex::new(&format!(r"(?m)^## {}[^\n]*\n", regex::escape(title))).expect("section regex");
    let Some(m) = heading.find(body) else {
        return String::new();
    };
    let rest = &body[m.end()..];
    let next = Regex::new(r"(?m)^## ").expect("next regex");
    match next.find(rest) {
        Some(n) => rest[..n.start()].trim().to_string(),
        None => rest.trim().to_string(),
    }
}

/// The first non-blank line, clipped to `limit` characters with an ellipsis.
pub fn first_line(text: &str, limit: usize) -> String {
    for ln in text.lines() {
        let ln = ln.trim();
        if ln.is_empty() {
            continue;
        }
        let n = ln.chars().count();
        if n > limit {
            let cut: String = ln.chars().take(limit.saturating_sub(1)).collect();
            return format!("{cut}…");
        }
        return ln.to_string();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quoted_id_loses_its_quotes_and_nothing_else() {
        let s = split("---\nid: \"017\"\ntitle: 'a: b'\nkind: research\n---\n\n## X\nbody\n");
        assert_eq!(s.get("id"), Some("017"));
        assert_eq!(s.get("title"), Some("a: b"));
        assert_eq!(s.get("kind"), Some("research"));
        assert_eq!(s.body, "\n## X\nbody\n");
        assert_eq!(s.raw.len(), 3);
    }

    #[test]
    fn mismatched_quotes_stay_and_an_empty_value_is_empty() {
        let s = split("---\na: \"x'\nb:\nc:   \n---\n");
        assert_eq!(s.get("a"), Some("\"x'"));
        assert_eq!(s.get("b"), Some(""));
        assert_eq!(s.get("c"), Some(""));
        assert_eq!(s.get_nonempty("b"), None);
    }

    #[test]
    fn no_opening_or_no_closing_marker_means_the_whole_text_is_body() {
        let s = split("id: 1\n---\nbody");
        assert!(s.fields.is_empty());
        assert_eq!(s.body, "id: 1\n---\nbody");
        let s = split("---\nid: 1\nbody without a close");
        assert!(s.fields.is_empty());
        assert!(s.raw.is_empty());
        assert_eq!(s.body, "---\nid: 1\nbody without a close");
    }

    #[test]
    fn a_repeated_key_reads_as_its_last_value_like_a_python_dict() {
        let s = split("---\nstatus: todo\nstatus: done\n---\n");
        assert_eq!(s.get("status"), Some("done"));
        assert_eq!(s.fields.len(), 2);
    }

    #[test]
    fn lines_that_are_not_fields_are_kept_but_contribute_nothing() {
        let s = split("---\n# a comment\n- item\n1bad: x\nok: y\n---\nb");
        assert_eq!(s.fields, vec![("ok".to_string(), "y".to_string())]);
        assert_eq!(s.raw.len(), 4);
    }

    #[test]
    fn set_replaces_in_place_or_appends_and_keeps_the_rest_verbatim() {
        let t = "---\nid: \"017\"\nstatus: todo\n# note\n---\n\nbody\n";
        let out = set(t, "status", "in-progress");
        assert_eq!(
            out,
            "---\nid: \"017\"\nstatus: in-progress\n# note\n---\n\nbody\n"
        );
        let out = set(t, "follow_up", "041");
        assert_eq!(
            out,
            "---\nid: \"017\"\nstatus: todo\n# note\nfollow_up: 041\n---\n\nbody\n"
        );
        assert_eq!(set("plain body", "k", "v"), "---\nk: v\n---\nplain body");
    }

    #[test]
    fn section_reads_up_to_the_next_h2_and_ignores_h3() {
        let body =
            "\n## Question\nOne line?\n\n### detail\nmore\n\n## Answer\n\n## What it blocks\nx\n";
        assert_eq!(section(body, "Question"), "One line?\n\n### detail\nmore");
        assert_eq!(section(body, "Answer"), "");
        assert_eq!(section(body, "What it blocks"), "x");
        assert_eq!(section(body, "Missing"), "");
        assert_eq!(section("## Progress — appended\n- a\n", "Progress"), "- a");
    }

    #[test]
    fn first_line_skips_blanks_and_clips_by_characters() {
        assert_eq!(first_line("\n\n  hello world  \nnext", 110), "hello world");
        assert_eq!(first_line("ééééé", 4), "ééé…");
        assert_eq!(first_line("   \n", 10), "");
    }
}
