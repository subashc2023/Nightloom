//! A reply's `text_delta` stream, cut into sentences fit to be spoken
//! (nightshift backlog 246, wave 3; design §2.3 "Sentence by sentence").
//!
//! The first sentence is synthesized the moment it ends, so audio starts
//! while the model is still writing. A sentence ends at `.`, `!` or `?`
//! followed by white space (closing quotes, brackets and emphasis marks may
//! sit between), or at the end of a line — never inside a number ("3.5"),
//! after a common abbreviation ("e.g."), after a lone initial ("J."), or
//! after a list's own number ("2. "). A terminator at the very end of what
//! has arrived is not an end yet: the next delta may be "5" of "3.5".
//!
//! What is not spoken: code blocks (a fence becomes "I've put the code on
//! screen." once per reply), table rows, horizontal rules, images, and the
//! markdown itself — heading hashes, list markers, emphasis, backticks, and
//! a link's address (its words are kept). Tool steps never reach here: the
//! caller feeds `text_delta`s only and calls [`Splitter::flush`] at a tool
//! call, so the words before a tool and the words after it are not run
//! together into one sentence.

/// What a code block is replaced by, once per reply.
pub const CODE_ON_SCREEN: &str = "I've put the code on screen.";

/// Words that end in a full stop without ending a sentence. Compared
/// lowercase, without the stop. Not "no" (a spoken reply starts "No. …"
/// far more often than it cites a number) and not "etc." (it usually ends
/// the sentence it is in).
const ABBREVIATIONS: &[&str] = &[
    "e.g", "i.e", "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "fig", "approx", "cf",
    "al", "inc", "ltd", "mt", "ft", "dept", "u.s", "a.m", "p.m",
];

/// One reply's splitter. Feed it deltas; it hands back whole sentences.
#[derive(Debug, Default)]
pub struct Splitter {
    /// The line being written, raw, from its first character.
    line: String,
    /// How much of `line` has already gone out as sentences.
    spoken_to: usize,
    /// Inside a fenced code block.
    in_fence: bool,
    /// The code block's sentence has been said this reply.
    said_code: bool,
}

impl Splitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take one delta; return the sentences it completed, cleaned for
    /// speech, in order.
    pub fn push(&mut self, delta: &str) -> Vec<String> {
        let mut out = Vec::new();
        for ch in delta.chars() {
            if ch == '\n' {
                self.end_line(&mut out);
            } else {
                self.line.push(ch);
            }
        }
        self.scan_partial(&mut out);
        out
    }

    /// Whatever is left, as the last sentence(s) — at the end of a reply,
    /// and at a tool call so what follows starts afresh. Fence state
    /// survives a flush (a tool call inside a code block is still inside
    /// it); the once-per-reply code sentence does too.
    pub fn flush(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        self.end_line(&mut out);
        out
    }

    /// The reply is over: the next [`push`](Self::push) is a new reply.
    pub fn finish(&mut self) -> Vec<String> {
        let out = self.flush();
        *self = Self::default();
        out
    }

    fn end_line(&mut self, out: &mut Vec<String>) {
        let line = std::mem::take(&mut self.line);
        let from = std::mem::take(&mut self.spoken_to);
        let trimmed = line.trim();
        if is_fence(trimmed) {
            if self.in_fence {
                self.in_fence = false;
            } else {
                self.in_fence = true;
                if !self.said_code {
                    self.said_code = true;
                    out.push(CODE_ON_SCREEN.to_string());
                }
            }
            return;
        }
        if self.in_fence || is_unspoken_line(trimmed) {
            return;
        }
        let (body_start, _) = body_of(&line);
        let from = from.max(body_start);
        if from >= line.len() {
            return;
        }
        for s in sentences(&line[from..], true) {
            push_clean(out, s);
        }
    }

    /// Sentences that are already complete inside the unfinished line.
    fn scan_partial(&mut self, out: &mut Vec<String>) {
        if self.in_fence {
            return;
        }
        let trimmed = self.line.trim_start();
        // Could still become a fence, a table row or a rule: wait for the
        // line to finish before saying anything of it.
        if trimmed.is_empty()
            || trimmed.starts_with('`')
            || trimmed.starts_with('~')
            || trimmed.starts_with('|')
            || (self.spoken_to == 0 && !has_decided_start(trimmed))
        {
            return;
        }
        let (body_start, _) = body_of(&self.line);
        let from = self.spoken_to.max(body_start);
        if from >= self.line.len() {
            return;
        }
        let rest = &self.line[from..];
        let mut consumed = 0;
        for s in sentences(rest, false) {
            consumed = s.as_ptr() as usize - rest.as_ptr() as usize + s.len();
            push_clean(out, s);
        }
        if consumed > 0 {
            self.spoken_to = from + consumed;
        }
    }
}

fn push_clean(out: &mut Vec<String>, raw: &str) {
    if let Some(s) = speakable(raw) {
        out.push(s);
    }
}

/// A fence line: three or more backticks or tildes.
fn is_fence(trimmed: &str) -> bool {
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

/// Lines with nothing to say aloud: table rows (and their `|---|` rules),
/// horizontal rules, and a line that is only an image.
fn is_unspoken_line(trimmed: &str) -> bool {
    if trimmed.starts_with('|') {
        return true;
    }
    let rule_chars: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    if rule_chars.len() >= 3
        && (rule_chars.chars().all(|c| c == '-')
            || rule_chars.chars().all(|c| c == '*')
            || rule_chars.chars().all(|c| c == '_'))
    {
        return true;
    }
    trimmed.starts_with("![") && trimmed.ends_with(')')
}

/// Whether enough of the line has arrived to know it is prose and where
/// its body starts: a list marker needs the space after it to be one.
fn has_decided_start(trimmed: &str) -> bool {
    let first = trimmed.chars().next().unwrap_or(' ');
    if first.is_ascii_digit() {
        // "12" could be "12. item" or "12 apples": decided at the first
        // character that is not a digit, plus one if it is `.` or `)`.
        let rest = trimmed.trim_start_matches(|c: char| c.is_ascii_digit());
        return match rest.chars().next() {
            None => false,
            Some('.') | Some(')') => rest.chars().nth(1).is_some(),
            Some(_) => true,
        };
    }
    if matches!(first, '-' | '*' | '+' | '#' | '>' | '_' | '=') {
        // A marker, a rule or a heading: decided once something that is
        // not one of these has arrived.
        return trimmed
            .chars()
            .any(|c| !matches!(c, '-' | '*' | '+' | '#' | '>' | '_' | '=' | ' '));
    }
    true
}

/// Where the line's words start, past its heading hashes, quote marks and
/// list marker; and whether it had a marker at all.
fn body_of(line: &str) -> (usize, bool) {
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut marked = false;
    loop {
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
        }
        let rest = &line[i..];
        if rest.starts_with('>') {
            i += 1;
            marked = true;
            continue;
        }
        if rest.starts_with('#') {
            let hashes = rest.chars().take_while(|&c| c == '#').count();
            if rest[hashes..].starts_with(' ') {
                i += hashes + 1;
                marked = true;
                continue;
            }
        }
        if (rest.starts_with("- ") || rest.starts_with("* ") || rest.starts_with("+ "))
            && !marked_as_rule(rest)
        {
            i += 2;
            marked = true;
            continue;
        }
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits > 0 && digits <= 3 {
            let after = &rest[digits..];
            if after.starts_with(". ") || after.starts_with(") ") {
                i += digits + 2;
                marked = true;
                continue;
            }
        }
        // A task list's box.
        if marked && (rest.starts_with("[ ] ") || rest.starts_with("[x] ")) {
            i += 4;
        }
        return (i, marked);
    }
}

fn marked_as_rule(rest: &str) -> bool {
    let c: String = rest.chars().filter(|c| !c.is_whitespace()).collect();
    c.len() >= 3 && c.chars().all(|x| x == '-' || x == '*')
}

/// Cut `text` at sentence ends. With `to_end`, the tail after the last end
/// is a sentence too (the line is over); without it the tail is left.
fn sentences(text: &str, to_end: bool) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut k = 0;
    while k < chars.len() {
        let (i, c) = chars[k];
        if matches!(c, '.' | '!' | '?' | '…') {
            // Run of terminators ("?!", "...") and closers after them.
            let mut j = k + 1;
            while j < chars.len() && matches!(chars[j].1, '.' | '!' | '?' | '…') {
                j += 1;
            }
            while j < chars.len()
                && matches!(
                    chars[j].1,
                    '"' | '\'' | '”' | '’' | ')' | ']' | '*' | '_' | '`'
                )
            {
                j += 1;
            }
            let end = chars.get(j).map_or(text.len(), |&(b, _)| b);
            let followed_by_space = chars.get(j).is_some_and(|&(_, n)| n.is_whitespace());
            if followed_by_space && !(c == '.' && j == k + 1 && not_an_end(&text[start..i])) {
                out.push(&text[start..end]);
                start = end;
            }
            k = j.max(k + 1);
            continue;
        }
        let _ = i;
        k += 1;
    }
    if to_end && start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// Whether a full stop after `before` belongs to the word rather than
/// ending the sentence: an abbreviation, or a lone capital initial.
fn not_an_end(before: &str) -> bool {
    let word = before
        .rsplit(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("");
    let word = word.trim_start_matches(['"', '\'', '*', '_', '“', '‘']);
    if word.is_empty() {
        return false;
    }
    let lower = word.to_lowercase();
    if ABBREVIATIONS.contains(&lower.as_str()) {
        return true;
    }
    let mut cs = word.chars();
    matches!((cs.next(), cs.next()), (Some(c), None) if c.is_uppercase())
}

/// A sentence as it should be said: markdown gone, white space folded, a
/// bare address replaced. `None` when nothing speakable is left.
pub fn speakable(raw: &str) -> Option<String> {
    let mut s = String::with_capacity(raw.len());
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // ![alt](url): gone. [words](url): the words.
        if c == '!'
            && chars.get(i + 1) == Some(&'[')
            && let Some((_, after)) = link_at(&chars, i + 1)
        {
            i = after;
            continue;
        }
        if c == '['
            && let Some((words, after)) = link_at(&chars, i)
        {
            s.push_str(&words);
            i = after;
            continue;
        }
        if matches!(c, '*' | '`' | '#') {
            i += 1;
            continue;
        }
        // Underscores as emphasis, not inside a word (snake_case stays).
        if c == '_' {
            let prev_word = i > 0 && chars[i - 1].is_alphanumeric();
            let next_word = chars.get(i + 1).is_some_and(|n| n.is_alphanumeric());
            if !(prev_word && next_word) {
                i += 1;
                continue;
            }
        }
        if c == '~' && chars.get(i + 1) == Some(&'~') {
            i += 2;
            continue;
        }
        s.push(c);
        i += 1;
    }
    let words: Vec<String> = s
        .split_whitespace()
        .map(|w| {
            if w.starts_with("http://") || w.starts_with("https://") {
                "a link".to_string()
            } else {
                w.to_string()
            }
        })
        .collect();
    let out = words.join(" ");
    let out = out.trim();
    if out.chars().any(|c| c.is_alphanumeric()) {
        Some(out.to_string())
    } else {
        None
    }
}

/// `[words](target)` starting at `open`: the words, and the index after
/// the closing parenthesis.
fn link_at(chars: &[char], open: usize) -> Option<(String, usize)> {
    let close = open + chars[open..].iter().position(|&c| c == ']')?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = close + 1 + chars[close + 1..].iter().position(|&c| c == ')')?;
    Some((chars[open + 1..close].iter().collect(), end + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed `deltas` one by one and collect everything, finish included.
    fn run(deltas: &[&str]) -> Vec<String> {
        let mut sp = Splitter::new();
        let mut out = Vec::new();
        for d in deltas {
            out.extend(sp.push(d));
        }
        out.extend(sp.finish());
        out
    }

    #[test]
    fn plain_sentences_come_out_one_by_one() {
        assert_eq!(
            run(&["It is sunny. The machine is idle! Want more? "]),
            vec!["It is sunny.", "The machine is idle!", "Want more?"]
        );
    }

    #[test]
    fn the_first_sentence_is_out_before_the_reply_ends() {
        let mut sp = Splitter::new();
        assert!(sp.push("It is").is_empty());
        assert!(sp.push(" sunny.").is_empty(), "no space yet: could be 3.5");
        assert_eq!(sp.push(" The"), vec!["It is sunny."]);
        assert_eq!(sp.finish(), vec!["The"]);
    }

    #[test]
    fn a_sentence_split_across_deltas_is_one_sentence() {
        assert_eq!(
            run(&["The fi", "le is re", "ady. Ne", "xt step."]),
            vec!["The file is ready.", "Next step."]
        );
    }

    #[test]
    fn decimals_are_not_sentence_ends_even_split_across_deltas() {
        assert_eq!(
            run(&["It costs 3.", "5 dollars a month. That is all."]),
            vec!["It costs 3.5 dollars a month.", "That is all."]
        );
        assert_eq!(
            run(&["Version 1.2.3 shipped. "]),
            vec!["Version 1.2.3 shipped."]
        );
    }

    #[test]
    fn abbreviations_and_initials_do_not_end_a_sentence() {
        assert_eq!(
            run(&[
                "Use a small voice, e.g. Lessac, not a big one. Dr. Smith agrees. J. R. R. Tolkien wrote it."
            ]),
            vec![
                "Use a small voice, e.g. Lessac, not a big one.",
                "Dr. Smith agrees.",
                "J. R. R. Tolkien wrote it."
            ]
        );
    }

    #[test]
    fn a_newline_ends_a_sentence_without_punctuation() {
        assert_eq!(
            run(&["Two things\nFirst one\n"]),
            vec!["Two things", "First one"]
        );
    }

    #[test]
    fn a_code_block_is_said_once_and_never_read() {
        let out = run(&[
            "Here it is.\n```rust\nfn main() { println!(\"hi. there\"); }\n```\nAnd a second:\n```\nls -la\n```\nDone.",
        ]);
        assert_eq!(
            out,
            vec!["Here it is.", CODE_ON_SCREEN, "And a second:", "Done."]
        );
        assert!(!out.iter().any(|s| s.contains("println")));
    }

    #[test]
    fn a_fence_split_across_deltas_is_still_a_fence() {
        let out = run(&["Look:\n`", "``py\nprint(1", ". 2)\n``", "`\nOk."]);
        assert_eq!(out, vec!["Look:", CODE_ON_SCREEN, "Ok."]);
    }

    #[test]
    fn lists_lose_their_markers_and_numbers_are_not_sentences() {
        assert_eq!(
            run(&[
                "Steps:\n1. Open the app. Then wait.\n2. Tap the orb\n- a dash item\n* a star item\n"
            ]),
            vec![
                "Steps:",
                "Open the app.",
                "Then wait.",
                "Tap the orb",
                "a dash item",
                "a star item"
            ]
        );
    }

    #[test]
    fn a_list_number_arriving_alone_waits_for_its_line() {
        let mut sp = Splitter::new();
        assert!(sp.push("1").is_empty());
        assert!(sp.push(".").is_empty());
        assert!(sp.push(" Open it. The").iter().eq(["Open it."].iter()));
        assert_eq!(sp.finish(), vec!["The"]);
    }

    #[test]
    fn tables_rules_and_headings() {
        assert_eq!(
            run(&["## The answer\n| a | b |\n|---|---|\n| 1 | 2 |\n---\nThat is the table.\n"]),
            vec!["The answer", "That is the table."]
        );
    }

    #[test]
    fn markdown_is_stripped_and_links_keep_their_words() {
        assert_eq!(
            run(&[
                "**Yes.** Read [the design](notes/design.md) and `voice.md` at https://example.com/x now. ![shot](a.png)\n"
            ]),
            vec!["Yes.", "Read the design and voice.md at a link now."]
        );
        assert_eq!(
            speakable("keep snake_case but _drop_ emphasis"),
            Some("keep snake_case but drop emphasis".into())
        );
    }

    #[test]
    fn a_flush_at_a_tool_call_keeps_the_rounds_apart() {
        let mut sp = Splitter::new();
        let mut out = sp.push("Let me check");
        out.extend(sp.flush());
        out.extend(sp.push("It is sunny."));
        out.extend(sp.finish());
        assert_eq!(out, vec!["Let me check", "It is sunny."]);
    }

    #[test]
    fn nothing_speakable_says_nothing() {
        assert!(run(&["---\n\n***\n", "| x |\n"]).is_empty());
        assert!(run(&["  \n\n"]).is_empty());
        assert_eq!(speakable("**"), None);
    }

    #[test]
    fn finish_starts_a_new_reply() {
        let mut sp = Splitter::new();
        assert_eq!(sp.push("```\ncode"), vec![CODE_ON_SCREEN]);
        assert!(sp.finish().is_empty(), "the rest of the code is not read");
        // The fence and the once-per-reply sentence are forgotten.
        assert_eq!(sp.push("New reply. "), vec!["New reply."]);
        assert_eq!(sp.push("\n```\nx\n```\n"), vec![CODE_ON_SCREEN]);
        assert!(sp.finish().is_empty());
    }

    #[test]
    fn quotes_and_brackets_after_a_stop_stay_with_their_sentence() {
        assert_eq!(
            run(&["He said \"go.\" Then (quietly.) we went."]),
            vec!["He said \"go.\"", "Then (quietly.)", "we went."]
        );
    }
}
