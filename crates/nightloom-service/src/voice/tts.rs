//! Text to speech: Piper (github.com/OHF-Voice/piper1-gpl, a small neural
//! voice) as one long-lived child process (design §2.3).
//!
//! Piper 1.x is a Python package; its command line loads the voice on every
//! run (~0.85 s measured on the Mac, 2026-09-30), which would be paid per
//! sentence. So the child is the venv's Python running [`LOOP`], a dozen
//! lines that load the voice once and then answer one sentence per request
//! line: a JSON line in on stdin, a length-prefixed WAV out on stdout.
//! Measured on the Mac: ~0.25 s per sentence once loaded.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// The child's program. Reads `{"text": …}` lines; writes, per line, a
/// 4-byte big-endian length and that many bytes of 16-bit mono WAV. The
/// first line out, before any request, is `ready <sample rate>`.
const LOOP: &str = r#"
import sys, json, io, wave
from piper import PiperVoice
voice = PiperVoice.load(sys.argv[1])
rate = voice.config.sample_rate
out = sys.stdout.buffer
out.write(("ready %d\n" % rate).encode()); out.flush()
for line in sys.stdin:
    try:
        text = json.loads(line).get("text", "")
    except Exception:
        text = ""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        if text.strip():
            for chunk in voice.synthesize(text):
                w.writeframes(chunk.audio_int16_bytes)
    data = buf.getvalue()
    out.write(len(data).to_bytes(4, "big")); out.write(data); out.flush()
"#;

/// How long the voice gets to load.
const START_WAIT: Duration = Duration::from_secs(60);

/// One sentence's ceiling.
const SPEAK_WAIT: Duration = Duration::from_secs(30);

/// A running Piper.
pub struct Piper {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    rate: u32,
}

impl Piper {
    /// Start `python` (the venv's, with `piper` installed) on `voice` (an
    /// `.onnx` with its `.onnx.json` beside it).
    pub async fn start(python: &Path, voice: &Path) -> Result<Self, String> {
        let mut child = Command::new(python)
            .arg("-u")
            .arg("-c")
            .arg(LOOP)
            .arg(voice)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("could not start Piper ({}): {e}", python.display()))?;
        let stdin = child.stdin.take().ok_or("Piper has no stdin")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("Piper has no stdout")?);
        let mut first = String::new();
        tokio::time::timeout(START_WAIT, stdout.read_line(&mut first))
            .await
            .map_err(|_| "Piper did not load its voice within a minute".to_string())?
            .map_err(|e| format!("Piper: {e}"))?;
        let rate = first
            .trim()
            .strip_prefix("ready ")
            .and_then(|r| r.parse().ok())
            .ok_or_else(|| {
                if first.is_empty() {
                    "Piper exited while loading its voice".to_string()
                } else {
                    format!("Piper said {first:?} instead of ready")
                }
            })?;
        Ok(Self {
            child,
            stdin,
            stdout,
            rate,
        })
    }

    /// The voice's sample rate (22 050 Hz for the medium voices).
    pub fn sample_rate(&self) -> u32 {
        self.rate
    }

    /// One sentence as a WAV file's bytes.
    pub async fn speak(&mut self, text: &str) -> Result<Vec<u8>, String> {
        let mut line = serde_json::json!({ "text": text }).to_string();
        line.push('\n');
        let work = async {
            self.stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("Piper: {e}"))?;
            self.stdin
                .flush()
                .await
                .map_err(|e| format!("Piper: {e}"))?;
            let mut len = [0u8; 4];
            self.stdout
                .read_exact(&mut len)
                .await
                .map_err(|e| format!("Piper: {e}"))?;
            let len = u32::from_be_bytes(len) as usize;
            let mut wav = vec![0u8; len];
            self.stdout
                .read_exact(&mut wav)
                .await
                .map_err(|e| format!("Piper: {e}"))?;
            Ok::<_, String>(wav)
        };
        tokio::time::timeout(SPEAK_WAIT, work)
            .await
            .map_err(|_| "Piper took longer than 30 s on one sentence".to_string())?
    }

    /// Whether the process is still running.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}
