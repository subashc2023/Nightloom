//! The phone's voice mode, host side (nightshift backlog 246, wave 3;
//! design `notes/research/246-phone-parity-voice-design-2026-09-30.md` §2
//! in nightshift-code).
//!
//! Speech is heard and spoken by the host — the Mac, or the away server —
//! because Safari's own recognition does not run in a home-screen web app.
//! The phone streams 16 kHz mono PCM over a WebSocket ([`session`]); the
//! host transcribes it with whisper.cpp ([`stt`]), sends the words as an
//! ordinary message marked `spoken`, cuts the reply's text stream into
//! sentences ([`split`]) and speaks each with Piper ([`tts`]) as soon as it
//! ends.
//!
//! A spoken turn is an ordinary turn in the same chat with Nightloom's
//! whole system prompt. What makes the model answer for the ear is a
//! per-turn note — `voice.md` in the config dir ([`note`]) — which rides
//! the CLI's `-p` text on the Claude Code engine ([`for_the_ear`]) and the
//! sidecar on a provider engine ([`crate::sidecar::with_spoken_note`]),
//! never the system prompt, whose bytes must not change turn to turn.
//!
//! The programs are found in `<config dir>/voice/` (what
//! `bin/voice-setup.sh` fetches) or on `PATH`; [`Setup::find`] says `None`
//! when either half is missing, and the host then reports no voice.

pub mod session;
pub mod split;
pub mod stt;
pub mod tts;
pub mod wav;

#[cfg(test)]
mod real;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// The phone's microphone rate: 16 kHz mono, whisper's own.
pub const MIC_RATE: u32 = 16_000;

/// An utterance shorter than this is a cough or a bump, never sent.
pub const MIN_UTTERANCE: Duration = Duration::from_millis(400);

/// The note a spoken turn carries when `voice.md` is absent — written there
/// the first time it is read, so he can edit it (design §2.4).
pub const DEFAULT_NOTE: &str = "This message was spoken aloud, and your reply will be read aloud to me while I walk. Answer for the ear: lead with the answer in plain sentences, usually two to four; no markdown, lists, tables or headings; no code or file paths unless I ask (say it is on screen); no preamble, no recap, no offer of more. Say numbers and names the way they are spoken. If you need to use tools, do, then tell me the result.\n";

/// `<config dir>/voice.md`.
pub fn note_path() -> Option<PathBuf> {
    crate::project::config_dir().map(|d| d.join("voice.md"))
}

/// The per-turn note, from `voice.md`, which is created with
/// [`DEFAULT_NOTE`] when absent. An empty file means "no note" — his to
/// choose — and an unreadable config dir falls back to the default.
pub fn note() -> String {
    let Some(path) = note_path() else {
        return DEFAULT_NOTE.trim().to_string();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => text.trim().to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&path, DEFAULT_NOTE);
            DEFAULT_NOTE.trim().to_string()
        }
        Err(_) => DEFAULT_NOTE.trim().to_string(),
    }
}

/// What the Claude Code engine is given as `-p` for a spoken turn: his
/// words, a blank line, the note. The log keeps his words alone.
pub fn for_the_ear(text: &str) -> String {
    with_note(text, &note())
}

fn with_note(text: &str, note: &str) -> String {
    if note.is_empty() {
        text.to_string()
    } else {
        format!("{text}\n\n{note}")
    }
}

/// What whisper writes for silence and noise, lowercase and without
/// punctuation. A final that is only these is dropped, never sent.
const NOISE: &[&str] = &[
    "you",
    "thank you",
    "thanks",
    "thanks for watching",
    "thank you for watching",
    "bye",
    "okay",
    "uh",
    "um",
    "hmm",
    "blank_audio",
    "silence",
    "music",
    "inaudible",
    "no speech",
];

/// Whether a transcript is whisper's habit on noise rather than words
/// (design §2.3): empty, a bracketed tag like `[BLANK_AUDIO]` or
/// `(wind blowing)`, or under three words that are all on the stop list.
pub fn is_noise(text: &str) -> bool {
    static TAGS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let tags = TAGS.get_or_init(|| {
        regex::Regex::new(r"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*").expect("a fixed pattern")
    });
    let words = tags.replace_all(text, " ");
    let cleaned: String = words
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '\'' {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return true;
    }
    cleaned.split(' ').count() <= 3 && NOISE.contains(&cleaned.as_str())
}

/// Where the programs and models are.
#[derive(Debug, Clone, PartialEq)]
pub struct Setup {
    pub whisper_server: PathBuf,
    /// The model for partials while he talks: `base.en`, or `small.en`
    /// when that is the only one.
    pub partial_model: PathBuf,
    /// The model for the final pass after the pause: `small.en`, or
    /// `base.en` when that is the only one.
    pub final_model: PathBuf,
    /// The venv's Python with `piper` installed.
    pub piper_python: PathBuf,
    /// The voice, an `.onnx` with its `.onnx.json` beside it.
    pub voice: PathBuf,
}

impl Setup {
    /// Look in `<config dir>/voice/`, then `PATH` for the server.
    pub fn find() -> Option<Self> {
        Self::find_in(&crate::project::config_dir()?.join("voice"))
    }

    /// [`find`](Self::find) under `dir`. `NIGHTLOOM_VOICE` picks a voice by
    /// name; otherwise the first `.onnx` in `voices/` by name.
    pub fn find_in(dir: &Path) -> Option<Self> {
        let whisper_server = [dir.join("bin/whisper-server")]
            .into_iter()
            .find(|p| p.is_file())
            .or_else(|| on_path("whisper-server"))?;
        let base = dir.join("models/ggml-base.en.bin");
        let small = dir.join("models/ggml-small.en.bin");
        let (partial_model, final_model) = match (base.is_file(), small.is_file()) {
            (true, true) => (base, small),
            (true, false) => (base.clone(), base),
            (false, true) => (small.clone(), small),
            (false, false) => return None,
        };
        let piper_python = [dir.join("piper/bin/python3"), dir.join("piper/bin/python")]
            .into_iter()
            .find(|p| p.is_file())?;
        let voices = dir.join("voices");
        let voice = match std::env::var("NIGHTLOOM_VOICE")
            .ok()
            .filter(|v| !v.is_empty())
        {
            Some(name) => Some(voices.join(format!("{name}.onnx"))).filter(|p| p.is_file()),
            None => {
                let mut all: Vec<PathBuf> = std::fs::read_dir(&voices)
                    .ok()?
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.extension().is_some_and(|x| x == "onnx"))
                    .collect();
                all.sort();
                all.into_iter().next()
            }
        }?;
        if !voice.with_extension("onnx.json").is_file() {
            return None;
        }
        Some(Self {
            whisper_server,
            partial_model,
            final_model,
            piper_python,
            voice,
        })
    }
}

fn on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join(name))
            .find(|p| p.is_file())
    })
}

/// What `/api/state` says about voice, so the page knows whether to offer
/// the orb or the keyboard-dictation fallback.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VoiceInfo {
    /// The reply's audio rate (Piper's voice), for the page's player.
    pub sample_rate: Option<u32>,
    /// The phone's microphone rate the host expects.
    pub mic_rate: u32,
    /// The voice's file name, e.g. `en_US-lessac-medium`.
    pub voice: String,
}

/// Which whisper pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pass {
    /// While he talks, every ~700 ms: fast, rough.
    Partial,
    /// After the pause: the words that are sent.
    Final,
}

/// Hearing, as the socket session needs it (the engine, or a test's fake).
#[async_trait::async_trait]
pub trait Hear: Send + Sync {
    async fn transcribe(&self, pcm: &[i16], pass: Pass) -> Result<String, String>;
}

/// Speaking, as the socket session needs it.
#[async_trait::async_trait]
pub trait Speak: Send + Sync {
    /// One sentence as a WAV file's bytes.
    async fn speak(&self, text: &str) -> Result<Vec<u8>, String>;
}

/// The host's voice: the two whisper servers and Piper, started on first
/// use and stopped after [`Engine::stop_if_idle`]'s idle time.
pub struct Engine {
    setup: Setup,
    partial: Mutex<Option<stt::Whisper>>,
    final_: Mutex<Option<stt::Whisper>>,
    piper: Mutex<Option<tts::Piper>>,
    rate: std::sync::Mutex<Option<u32>>,
    last_used: std::sync::Mutex<Instant>,
}

impl Engine {
    pub fn new(setup: Setup) -> Arc<Self> {
        Arc::new(Self {
            setup,
            partial: Mutex::new(None),
            final_: Mutex::new(None),
            piper: Mutex::new(None),
            rate: std::sync::Mutex::new(None),
            last_used: std::sync::Mutex::new(Instant::now()),
        })
    }

    /// The engine over what [`Setup::find`] finds, or `None`.
    pub fn find() -> Option<Arc<Self>> {
        Setup::find().map(Self::new)
    }

    pub fn setup(&self) -> &Setup {
        &self.setup
    }

    pub fn info(&self) -> VoiceInfo {
        VoiceInfo {
            sample_rate: *self.rate.lock().unwrap_or_else(|p| p.into_inner()),
            mic_rate: MIC_RATE,
            voice: self
                .setup
                .voice
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
    }

    /// Start all three processes now rather than on the first utterance —
    /// what a socket's `hello` does, so the model loads while he starts
    /// talking. Returns the reply audio's sample rate.
    pub async fn warm(&self) -> Result<u32, String> {
        self.touch();
        let (a, b, c) = tokio::join!(
            self.ensure_whisper(Pass::Partial),
            self.ensure_whisper(Pass::Final),
            self.ensure_piper()
        );
        a?;
        b?;
        c
    }

    async fn ensure_whisper(&self, pass: Pass) -> Result<(), String> {
        let (slot, model) = match pass {
            Pass::Partial => (&self.partial, &self.setup.partial_model),
            Pass::Final => (&self.final_, &self.setup.final_model),
        };
        // One model for both passes: one server.
        if pass == Pass::Final && self.setup.partial_model == self.setup.final_model {
            return Box::pin(self.ensure_whisper(Pass::Partial)).await;
        }
        let mut g = slot.lock().await;
        if g.as_mut().is_some_and(|w| w.alive()) {
            return Ok(());
        }
        *g = Some(stt::Whisper::start(&self.setup.whisper_server, model).await?);
        Ok(())
    }

    async fn ensure_piper(&self) -> Result<u32, String> {
        let mut g = self.piper.lock().await;
        if let Some(p) = g.as_mut()
            && p.alive()
        {
            return Ok(p.sample_rate());
        }
        let p = tts::Piper::start(&self.setup.piper_python, &self.setup.voice).await?;
        let rate = p.sample_rate();
        *self.rate.lock().unwrap_or_else(|p| p.into_inner()) = Some(rate);
        *g = Some(p);
        Ok(rate)
    }

    /// Stop every process when nothing has used the engine for `idle`
    /// (the Mac's host: ten minutes, design §5 wave 3 row 3C). Returns
    /// whether it stopped them. The next use starts them again.
    pub async fn stop_if_idle(&self, idle: Duration) -> bool {
        let quiet = self
            .last_used
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .elapsed();
        if quiet < idle {
            return false;
        }
        self.stop().await;
        true
    }

    /// Stop every process now.
    pub async fn stop(&self) {
        *self.partial.lock().await = None;
        *self.final_.lock().await = None;
        *self.piper.lock().await = None;
    }

    /// Run [`stop_if_idle`](Self::stop_if_idle) once a minute for as long
    /// as the engine lives — the host calls this once after creating it.
    pub fn spawn_idle_reaper(self: &Arc<Self>, idle: Duration) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(me) = weak.upgrade() else { return };
                me.stop_if_idle(idle).await;
            }
        });
    }
}

#[async_trait::async_trait]
impl Hear for Engine {
    async fn transcribe(&self, pcm: &[i16], pass: Pass) -> Result<String, String> {
        self.touch();
        let pass = if self.setup.partial_model == self.setup.final_model {
            Pass::Partial
        } else {
            pass
        };
        self.ensure_whisper(pass).await?;
        let slot = match pass {
            Pass::Partial => &self.partial,
            Pass::Final => &self.final_,
        };
        let g = slot.lock().await;
        let w = g.as_ref().ok_or("whisper stopped")?;
        w.transcribe(pcm).await
    }
}

#[async_trait::async_trait]
impl Speak for Engine {
    async fn speak(&self, text: &str) -> Result<Vec<u8>, String> {
        self.touch();
        self.ensure_piper().await?;
        let mut g = self.piper.lock().await;
        let p = g.as_mut().ok_or("Piper stopped")?;
        match p.speak(text).await {
            Ok(wav) => Ok(wav),
            Err(e) => {
                // A timeout mid-frame leaves the pipe out of step: start
                // afresh next sentence rather than read someone else's.
                *g = None;
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whispers_noise_habits_are_dropped_and_real_words_are_not() {
        for noise in [
            "",
            " Thank you.",
            "you",
            "[BLANK_AUDIO]",
            "(wind blowing)",
            "*music*",
            "Thanks for watching!",
            "Um.",
        ] {
            assert!(is_noise(noise), "{noise:?} should be noise");
        }
        for words in [
            "Thank you, that's it.",
            "What's the weather like?",
            "Stop.",
            "yes",
            "Thank you for the summary of the plan",
        ] {
            assert!(!is_noise(words), "{words:?} should be sent");
        }
    }

    #[test]
    fn the_ear_note_follows_his_words_after_a_blank_line() {
        assert_eq!(with_note("hi", "short, please"), "hi\n\nshort, please");
        assert_eq!(with_note("hi", ""), "hi");
    }

    #[test]
    fn setup_finds_the_layout_voice_setup_writes_and_refuses_a_half_one() {
        let dir = std::env::temp_dir().join(format!("nl-voice-setup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for f in [
            "bin/whisper-server",
            "models/ggml-small.en.bin",
            "piper/bin/python3",
            "voices/en_US-lessac-medium.onnx",
        ] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"x").unwrap();
        }
        // No `.onnx.json` beside the voice: not usable.
        assert_eq!(Setup::find_in(&dir), None);
        std::fs::write(dir.join("voices/en_US-lessac-medium.onnx.json"), b"{}").unwrap();
        let s = Setup::find_in(&dir).expect("complete");
        assert_eq!(
            s.partial_model, s.final_model,
            "one model serves both passes"
        );
        std::fs::write(dir.join("models/ggml-base.en.bin"), b"x").unwrap();
        let s = Setup::find_in(&dir).unwrap();
        assert!(s.partial_model.ends_with("ggml-base.en.bin"));
        assert!(s.final_model.ends_with("ggml-small.en.bin"));
        assert_eq!(s.whisper_server, dir.join("bin/whisper-server"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
