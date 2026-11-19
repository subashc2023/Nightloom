//! Listen (nightshift backlog 801, from 793's decision §4 row 8): a reply,
//! a note or a morning page read aloud by the host's Piper voice — the
//! same voice the phone's voice mode answers in ([`super::tts`]) — as one
//! WAV file, so the Mac's window and the phone's page can play, pause,
//! change speed and seek it like any audio, and the phone keeps playing
//! with the screen locked. Nothing leaves his machines: the text goes to
//! the host's Piper, the audio comes back to his own window or phone.
//!
//! "Brief" first has the model rewrite the text for the ear in under two
//! minutes and say what it left out ([`brief_spec`], [`brief_message`]):
//! a one-shot turn of the chat namer's shape — no tools, no MCP servers,
//! one round, no session file, an empty scratch folder.

use super::{Speak, split::Splitter, wav};
use crate::agent::{AgentSpec, PassSpec};
use std::path::Path;

/// The most text one Listen reads, in characters (about 40 minutes of
/// speech); past it the rest is cut, and the last sentence says so.
pub const MAX_CHARS: usize = 60_000;

/// Words a minute Piper's voices speak at, near enough: a Brief under two
/// minutes is under ~300 words.
pub const BRIEF_WORDS: usize = 280;

/// The model a Brief runs on.
pub const BRIEF_MODEL: &str = "haiku";

/// The longest line Piper is given at once, in characters (~25 s of
/// speech). The splitter keeps a table or a long paragraph without stops
/// as one "sentence"; on a morning page one ran 17 s before Piper answered
/// (item 862). A longer line is cut at a clause, or else a word, boundary.
pub const LINE_CHARS: usize = 400;

/// Item 862: the first part's size in characters (~25 s of speech at
/// Piper's ~15 characters a second), so the first audio is back within a
/// few seconds of Piper starting.
pub const FIRST_PART_CHARS: usize = 400;

/// Item 862: how much bigger each part may be than the one before. Piper
/// makes audio at about 0.12× real time, so a part four times as long as
/// the one playing is made in about half the time that one plays: the
/// next part is always there before the player needs it.
pub const PART_GROWTH: usize = 4;

/// The text as the sentences Piper is given, markdown gone (the voice
/// mode's own splitter: a code block becomes one "code on screen" line),
/// none longer than [`LINE_CHARS`].
pub fn sentences(text: &str) -> Vec<String> {
    let (body, cut) = match text.char_indices().nth(MAX_CHARS) {
        Some((i, _)) => (&text[..i], true),
        None => (text, false),
    };
    let mut s = Splitter::new();
    let mut raw = s.push(body);
    raw.extend(s.finish());
    let mut out = Vec::with_capacity(raw.len());
    for line in raw {
        if line.trim().is_empty() {
            continue;
        }
        out.extend(cut_long(line.trim(), LINE_CHARS));
    }
    if cut {
        out.push("The rest is longer than one listen reads, and was left out.".into());
    }
    out
}

/// `line` in pieces of at most `max` characters, each cut after the last
/// clause mark (`,` `;` `:` or a dash) in reach, else the last space, else
/// at `max` itself.
fn cut_long(line: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while rest.chars().count() > max {
        let end = rest.char_indices().nth(max).map_or(rest.len(), |(i, _)| i);
        let head = &rest[..end];
        let at = head
            .rmatch_indices([',', ';', ':', '\u{2014}', '\u{2013}'])
            .map(|(i, m)| i + m.len())
            .find(|&i| i > max / 3)
            .or_else(|| head.rfind(' ').filter(|&i| i > 0))
            .unwrap_or(end);
        let piece = rest[..at].trim();
        if !piece.is_empty() {
            out.push(piece.to_string());
        }
        rest = rest[at..].trim_start();
    }
    if !rest.trim().is_empty() {
        out.push(rest.trim().to_string());
    }
    out
}

/// Item 862: the sentences in parts — the first about
/// [`FIRST_PART_CHARS`] long, each next up to [`PART_GROWTH`] times the
/// one before — so playback starts after one short part and never waits
/// for the next. Every part holds at least one sentence.
pub fn plan(lines: &[String]) -> Vec<std::ops::Range<usize>> {
    let mut parts = Vec::new();
    let mut budget = FIRST_PART_CHARS;
    let mut start = 0;
    while start < lines.len() {
        let mut end = start;
        let mut chars = 0;
        while end < lines.len() {
            let n = lines[end].chars().count();
            if end > start && chars + n > budget {
                break;
            }
            chars += n;
            end += 1;
        }
        parts.push(start..end);
        start = end;
        budget = budget.saturating_mul(PART_GROWTH);
    }
    parts
}

/// Read `text` aloud as one 16-bit mono WAV file. Each sentence is spoken
/// on its own (Piper's own unit) and the samples are joined with a short
/// pause between sentences.
pub async fn read_aloud(voice: &dyn Speak, text: &str) -> Result<Vec<u8>, String> {
    let lines = sentences(text);
    if lines.is_empty() {
        return Err("there is nothing to read aloud here".into());
    }
    speak_lines(voice, &lines, false).await
}

/// Item 862: part `part` of `text` read aloud (see [`plan`]), and how many
/// parts there are. Every part after the first starts with the pause that
/// would have stood between its first sentence and the one before, so the
/// parts played one after another sound like one file.
pub async fn read_part(
    voice: &dyn Speak,
    text: &str,
    part: usize,
) -> Result<(Vec<u8>, usize), String> {
    let lines = sentences(text);
    if lines.is_empty() {
        return Err("there is nothing to read aloud here".into());
    }
    let parts = plan(&lines);
    let range = parts
        .get(part)
        .cloned()
        .ok_or_else(|| format!("there is no part {part} (it has {})", parts.len()))?;
    let wav = speak_lines(voice, &lines[range], part > 0).await?;
    Ok((wav, parts.len()))
}

/// The number of parts `text` is read in ([`plan`]); 0 when there is
/// nothing to read.
pub fn part_count(text: &str) -> usize {
    plan(&sentences(text)).len()
}

async fn speak_lines(voice: &dyn Speak, lines: &[String], lead: bool) -> Result<Vec<u8>, String> {
    let mut rate = 0u32;
    let mut pcm: Vec<i16> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let bytes = voice.speak(line).await?;
        let (r, samples) =
            wav::decode(&bytes).ok_or("Piper gave back audio that is not a WAV file")?;
        if rate == 0 {
            rate = r;
        } else if r != rate {
            return Err(format!(
                "Piper changed its sample rate mid-read ({rate} → {r})"
            ));
        }
        if i > 0 || lead {
            // A quarter second between sentences.
            pcm.extend(std::iter::repeat_n(0i16, (rate / 4) as usize));
        }
        pcm.extend(samples);
    }
    Ok(wav::encode(&pcm, rate))
}

/// What a Brief turn is asked: the text, and how to rewrite it.
pub fn brief_message(text: &str) -> String {
    let body: String = text.chars().take(MAX_CHARS).collect();
    format!(
        "Rewrite the text below so it can be read aloud to me in under two minutes — at most {BRIEF_WORDS} words. \
         Write for the ear: plain spoken sentences, no markdown, lists, tables, headings, code or file paths; \
         lead with what matters most; say numbers and names the way they are spoken. \
         End with one sentence that begins \"Left out:\" and names what you dropped, briefly; \
         if you dropped nothing, end with \"Left out: nothing.\" \
         Reply with the rewrite alone.\n\n<text>\n{body}\n</text>"
    )
}

/// The Brief turn's spec: the chat's binary and subscription, a fixed
/// cheap model, no tools, no MCP servers, one round, no session file.
pub fn brief_spec(pass: &PassSpec, scratch: &Path) -> AgentSpec {
    let mut spec = pass.spec_in(scratch);
    spec.model = Some(BRIEF_MODEL.to_string());
    spec.tools = Some(Vec::new());
    crate::dream::strict_mcp(&mut spec);
    spec.max_turns = Some(1);
    spec.no_session_persistence = true;
    spec.append_system_prompt = Some(IDENTITY.to_string());
    spec
}

const IDENTITY: &str = "You are Nightloom's reader. You have no tools and you do not chat: \
     your whole reply is the text you were asked for, written to be heard.";

/// The Brief's words as the model gave them, trimmed; an empty answer is
/// an error, not silence.
pub fn clean_brief(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        Err("the Brief came back empty".into())
    } else {
        Ok(t.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A voice that "speaks" each sentence as one sample per character.
    struct Fake {
        rate: u32,
        said: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl Speak for Fake {
        async fn speak(&self, text: &str) -> Result<Vec<u8>, String> {
            self.said.lock().unwrap().push(text.to_string());
            Ok(wav::encode(&vec![1i16; text.chars().count()], self.rate))
        }
    }

    #[test]
    fn sentences_drop_markdown_and_keep_order() {
        let s = sentences("# Title\n\nFirst **bold** point. Second point.\n\n- a list item\n");
        assert!(
            s.iter().all(|x| !x.contains('#') && !x.contains("**")),
            "{s:?}"
        );
        assert!(s.iter().any(|x| x.contains("First bold point")), "{s:?}");
        let first = s.iter().position(|x| x.contains("First")).unwrap();
        let second = s.iter().position(|x| x.contains("Second")).unwrap();
        assert!(first < second);
    }

    #[test]
    fn a_very_long_text_is_cut_and_says_so() {
        let long = "Word word word. ".repeat(MAX_CHARS / 8);
        let s = sentences(&long);
        assert!(s.last().unwrap().contains("left out"));
    }

    #[tokio::test]
    async fn read_aloud_joins_sentences_with_pauses_into_one_wav() {
        let v = Fake {
            rate: 100,
            said: Mutex::new(Vec::new()),
        };
        let bytes = read_aloud(&v, "One. Two.").await.unwrap();
        let (rate, pcm) = wav::decode(&bytes).unwrap();
        assert_eq!(rate, 100);
        let said = v.said.lock().unwrap().clone();
        assert_eq!(said.len(), 2, "{said:?}");
        let speech: usize = said.iter().map(|s| s.chars().count()).sum();
        assert_eq!(pcm.len(), speech + 25);
    }

    #[tokio::test]
    async fn nothing_to_read_is_an_error() {
        let v = Fake {
            rate: 100,
            said: Mutex::new(Vec::new()),
        };
        assert!(read_aloud(&v, "   \n").await.is_err());
    }

    /// The real voice (review 2026-11-18): `LISTEN_IN` (a text file) read
    /// aloud by the host's Piper under `~/.nightloom/voice/`, the WAV saved
    /// to `LISTEN_OUT`; prints when the first sentence came back (Piper's
    /// cold start), when the whole file was ready (the route's first byte:
    /// it answers only once the file is made) and the audio's length. Run
    /// by hand: `LISTEN_IN=… LISTEN_OUT=… cargo test -p nightloom-service
    /// --lib real_piper -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs the host's Piper voice (bin/voice-setup.sh)"]
    async fn real_piper_reads_a_file_aloud() {
        struct Timed {
            inner: std::sync::Arc<crate::voice::Engine>,
            t0: std::time::Instant,
            first: Mutex<Option<std::time::Duration>>,
        }
        #[async_trait::async_trait]
        impl Speak for Timed {
            async fn speak(&self, text: &str) -> Result<Vec<u8>, String> {
                let out = self.inner.speak(text).await;
                self.first
                    .lock()
                    .unwrap()
                    .get_or_insert_with(|| self.t0.elapsed());
                out
            }
        }
        let input = std::env::var("LISTEN_IN").expect("LISTEN_IN");
        let output = std::env::var("LISTEN_OUT").expect("LISTEN_OUT");
        let text = std::fs::read_to_string(&input).unwrap();
        let engine = crate::voice::Engine::find().expect("no voice set up");
        let v = Timed {
            inner: engine.clone(),
            t0: std::time::Instant::now(),
            first: Mutex::new(None),
        };
        // Item 862: the parts, one request after another as the player
        // asks for them, from a cold Piper: when the first audio is back,
        // and whether a part is ever late for the player.
        let n = part_count(&text);
        let mut ready = Vec::new();
        let mut lengths = Vec::new();
        for i in 0..n {
            let (bytes, _) = read_part(&v, &text, i).await.unwrap();
            ready.push(v.t0.elapsed().as_secs_f64());
            let (r, p) = wav::decode(&bytes).unwrap();
            lengths.push(p.len() as f64 / r as f64);
        }
        let mut ends = ready[0];
        let mut stall = 0.0f64;
        for i in 1..n {
            ends += lengths[i - 1];
            stall += (ready[i] - ends).max(0.0);
            ends = ends.max(ready[i]);
        }
        println!(
            "PARTS {n}: first audio {:.2}s, lengths {:?}, ready at {:?}, total stall {stall:.2}s",
            ready[0],
            lengths.iter().map(|x| x.round()).collect::<Vec<_>>(),
            ready.iter().map(|x| x.round()).collect::<Vec<_>>()
        );
        let v = Timed {
            inner: engine.clone(),
            t0: std::time::Instant::now(),
            first: Mutex::new(None),
        };
        let wav_bytes = read_aloud(&v, &text).await.unwrap();
        let whole = v.t0.elapsed();
        engine.stop().await;
        let (rate, pcm) = wav::decode(&wav_bytes).unwrap();
        std::fs::write(&output, &wav_bytes).unwrap();
        println!(
            "LISTEN {input}: {} chars, {} sentences, first sentence {:.2}s, whole file {:.2}s, audio {:.1}s at {rate} Hz, {} bytes",
            text.chars().count(),
            sentences(&text).len(),
            v.first.lock().unwrap().unwrap().as_secs_f64(),
            whole.as_secs_f64(),
            pcm.len() as f64 / rate as f64,
            wav_bytes.len()
        );
    }

    #[test]
    fn a_long_line_is_cut_at_a_clause_or_a_word() {
        let long = format!("{}, {}", "a".repeat(300), "word ".repeat(100));
        let s = sentences(&long);
        assert!(s.len() > 1, "{s:?}");
        assert!(s.iter().all(|x| x.chars().count() <= LINE_CHARS), "{s:?}");
        assert!(s[0].ends_with(','), "cut after the comma: {:?}", s[0]);
        let joined: String = s.join(" ");
        assert_eq!(
            joined.split_whitespace().count(),
            long.split_whitespace().count()
        );
        // No space at all: cut at the limit itself.
        let solid = sentences(&"x".repeat(LINE_CHARS * 2 + 5));
        assert_eq!(solid.len(), 3);
    }

    #[test]
    fn the_plan_starts_small_grows_and_covers_every_sentence_once() {
        let lines: Vec<String> = (0..400)
            .map(|i| format!("Sentence number {i:03} here."))
            .collect();
        let parts = plan(&lines);
        assert_eq!(parts[0].start, 0);
        assert_eq!(parts.last().unwrap().end, lines.len());
        for w in parts.windows(2) {
            assert_eq!(w[0].end, w[1].start);
        }
        let chars = |r: &std::ops::Range<usize>| -> usize {
            lines[r.clone()].iter().map(|l| l.chars().count()).sum()
        };
        assert!(chars(&parts[0]) <= FIRST_PART_CHARS);
        for w in parts.windows(2) {
            assert!(chars(&w[1]) <= chars(&w[0]) * PART_GROWTH + 30, "{parts:?}");
        }
        // One sentence longer than the budget is still a part of its own.
        let one = vec!["x".repeat(FIRST_PART_CHARS + 10)];
        assert_eq!(plan(&one), vec![0..1]);
        assert!(plan(&[]).is_empty());
    }

    #[tokio::test]
    async fn the_parts_played_in_turn_are_the_whole_file() {
        let v = Fake {
            rate: 100,
            said: Mutex::new(Vec::new()),
        };
        let text = "A short one. ".repeat(200);
        let whole = wav::decode(&read_aloud(&v, &text).await.unwrap())
            .unwrap()
            .1;
        let n = part_count(&text);
        assert!(n > 1);
        let mut joined = Vec::new();
        for i in 0..n {
            let (bytes, count) = read_part(&v, &text, i).await.unwrap();
            assert_eq!(count, n);
            joined.extend(wav::decode(&bytes).unwrap().1);
        }
        assert_eq!(joined.len(), whole.len());
        assert!(read_part(&v, &text, n).await.is_err());
    }

    #[test]
    fn the_brief_asks_for_under_two_minutes_and_what_was_left_out() {
        let m = brief_message("Some reply.");
        assert!(m.contains("under two minutes"));
        assert!(m.contains("Left out:"));
        assert!(m.contains("Some reply."));
        assert!(clean_brief("  \n").is_err());
        assert_eq!(clean_brief(" Hi. \n").unwrap(), "Hi.");
    }
}
