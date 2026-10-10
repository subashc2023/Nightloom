//! Speech to text: whisper.cpp's own HTTP server as a child process
//! (design §2.3). One server per model — `base.en` for the partials while
//! he talks, `small.en` for the final pass after the pause — each bound to
//! loopback on a free port, killed with its owner.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};

use super::wav;

/// How long a server gets to load its model and answer. A cold `small.en`
/// on the Mac measured under a second (2026-09-30, Metal); a cold Fly
/// machine reading from its volume is slower.
const START_WAIT: Duration = Duration::from_secs(60);

/// One transcription's ceiling. Whisper on an utterance of a minute is a
/// few seconds even on a CPU; a hung server must not hang the socket.
const INFER_WAIT: Duration = Duration::from_secs(60);

/// A running `whisper-server`.
pub struct Whisper {
    child: Child,
    url: String,
    http: reqwest::Client,
}

impl Whisper {
    /// Spawn `bin` on `model`, and wait until it answers.
    pub async fn start(bin: &Path, model: &Path) -> Result<Self, String> {
        let port = free_port()?;
        let mut cmd = Command::new(bin);
        cmd.arg("-m")
            .arg(model)
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            // Plain text out, no timestamps: the page shows words.
            .arg("--no-timestamps")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = cmd
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", bin.display()))?;
        let me = Self {
            child,
            url: format!("http://127.0.0.1:{port}"),
            http: reqwest::Client::builder()
                .timeout(INFER_WAIT)
                .build()
                .map_err(|e| e.to_string())?,
        };
        me.wait_ready().await?;
        Ok(me)
    }

    async fn wait_ready(&self) -> Result<(), String> {
        let start = Instant::now();
        while start.elapsed() < START_WAIT {
            if let Ok(r) = self.http.get(&self.url).send().await
                && r.status().is_success()
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("whisper-server did not come up within a minute".into())
    }

    /// Transcribe 16 kHz mono samples.
    pub async fn transcribe(&self, pcm: &[i16]) -> Result<String, String> {
        let wav = wav::encode(pcm, super::MIC_RATE);
        let boundary = format!("nightloom{:016x}", rand_u64());
        let body = multipart(
            &boundary,
            &[("response_format", b"json"), ("temperature", b"0")],
            ("file", "speech.wav", "audio/wav", &wav),
        );
        let r = self
            .http
            .post(format!("{}/inference", self.url))
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| format!("whisper-server: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("whisper-server answered {}", r.status()));
        }
        let v: serde_json::Value = r.json().await.map_err(|e| format!("whisper-server: {e}"))?;
        if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
            return Err(format!("whisper-server: {e}"));
        }
        Ok(v.get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "))
    }

    /// Whether the process is still running.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// A loopback port nobody holds right now. The window between dropping the
/// probe and the child binding is a race in principle; a lost race is a
/// start that fails and is retried on the next utterance.
pub(crate) fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn rand_u64() -> u64 {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    n ^ (std::process::id() as u64).rotate_left(32)
}

/// A `multipart/form-data` body: text fields, then one file. Written by
/// hand rather than turning on reqwest's `multipart` feature for one call.
fn multipart(boundary: &str, fields: &[(&str, &[u8])], file: (&str, &str, &str, &[u8])) -> Vec<u8> {
    let mut b = Vec::new();
    for (name, value) in fields {
        b.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n")
                .as_bytes(),
        );
        b.extend_from_slice(value);
        b.extend_from_slice(b"\r\n");
    }
    let (name, filename, mime, bytes) = file;
    b.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    b.extend_from_slice(bytes);
    b.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_multipart_body_has_each_field_and_the_file_then_the_close() {
        let body = multipart("B", &[("a", b"1")], ("file", "s.wav", "audio/wav", b"RIFF"));
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("--B\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n"));
        assert!(text.contains(
            "name=\"file\"; filename=\"s.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n"
        ));
        assert!(text.ends_with("--B--\r\n"));
    }
}
