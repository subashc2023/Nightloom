//! The real programs on real speech (design §5 wave 3, "Done when"): run by
//! hand, never by CI, because it needs `bin/voice-setup.sh`'s ~700 MB.
//!
//! ```text
//! NIGHTLOOM_VOICE_TEST=1 cargo test -p nightloom-service voice::real -- \
//!     --ignored --nocapture --test-threads 1
//! ```
//!
//! Reads `<voice dir>/fixtures/*.wav` with the words in the `.txt` beside
//! each (the setup script makes them with macOS `say`). `NIGHTLOOM_VOICE_DIR`
//! overrides the voice dir (default `~/.nightloom/voice`). Prints the
//! numbers the report quotes.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use super::session::{self, Deps, Inbound, Outbound, Timing, Turns};
use super::{Engine, Hear, MIC_RATE, Pass, Setup, Speak, wav};
use crate::remote::{Event, Handed, RemoteState};

fn voice_dir() -> Option<PathBuf> {
    if std::env::var("NIGHTLOOM_VOICE_TEST").ok().as_deref() != Some("1") {
        return None;
    }
    Some(
        std::env::var_os("NIGHTLOOM_VOICE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var("HOME").expect("HOME")).join(".nightloom/voice")
            }),
    )
}

fn fixtures(dir: &std::path::Path) -> Vec<(String, Vec<i16>, String)> {
    let mut out = Vec::new();
    let mut paths: Vec<_> = std::fs::read_dir(dir.join("fixtures"))
        .expect("fixtures/ — run bin/voice-setup.sh")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    paths.sort();
    for p in paths {
        let (rate, pcm) = wav::decode(&std::fs::read(&p).unwrap()).expect("16-bit mono WAV");
        assert_eq!(rate, MIC_RATE, "{} is not 16 kHz", p.display());
        let words = std::fs::read_to_string(p.with_extension("txt")).unwrap_or_default();
        out.push((
            p.file_stem().unwrap().to_string_lossy().into_owned(),
            pcm,
            words,
        ));
    }
    out
}

fn normal_words(s: &str) -> Vec<String> {
    s.split_whitespace()
        .map(|w| {
            w.chars()
                .filter(|c| c.is_alphanumeric() || *c == '\'')
                .collect::<String>()
                .to_lowercase()
                .replace('\'', "")
        })
        .filter(|w| !w.is_empty())
        .collect()
}

/// The share of `expected`'s words found in `got`, in order (a longest
/// common subsequence over words — word recall).
fn recall(expected: &str, got: &str) -> f64 {
    let a = normal_words(expected);
    let b = normal_words(got);
    if a.is_empty() {
        return 1.0;
    }
    let mut dp = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in 0..a.len() {
        for j in 0..b.len() {
            dp[i + 1][j + 1] = if a[i] == b[j] {
                dp[i][j] + 1
            } else {
                dp[i][j + 1].max(dp[i + 1][j])
            };
        }
    }
    dp[a.len()][b.len()] as f64 / a.len() as f64
}

#[tokio::test]
#[ignore = "needs bin/voice-setup.sh and NIGHTLOOM_VOICE_TEST=1"]
async fn the_real_programs_hear_the_fixtures_and_speak_a_reply() {
    let Some(dir) = voice_dir() else {
        eprintln!("NIGHTLOOM_VOICE_TEST is not 1: skipped");
        return;
    };
    let setup = Setup::find_in(&dir).expect("voice dir incomplete — run bin/voice-setup.sh");
    println!("setup: {setup:#?}");
    let engine = Engine::new(setup);

    let t = Instant::now();
    let rate = engine.warm().await.expect("warm");
    println!(
        "cold start (both whispers + Piper): {} ms",
        t.elapsed().as_millis()
    );
    assert_eq!(rate, 22_050, "a medium Piper voice");

    for (name, pcm, words) in fixtures(&dir) {
        let secs = pcm.len() as f64 / MIC_RATE as f64;
        for pass in [Pass::Partial, Pass::Final] {
            let t = Instant::now();
            let got = engine.transcribe(&pcm, pass).await.expect("transcribe");
            let ms = t.elapsed().as_millis();
            let r = recall(&words, &got);
            println!(
                "{name} ({secs:.2} s) {pass:?}: {ms} ms, recall {:.0}%: {got:?}",
                r * 100.0
            );
            if pass == Pass::Final {
                assert!(r >= 0.9, "{name}: {got:?} vs {words:?}");
            }
        }
    }

    for s in [
        "It is sunny on the away server.",
        "The machine has two gigabytes of memory, and it stops itself when idle.",
    ] {
        let t = Instant::now();
        let bytes = engine.speak(s).await.expect("speak");
        let (r, pcm) = wav::decode(&bytes).expect("a WAV");
        println!(
            "speak {:?}: {} ms for {:.2} s of audio ({} KB)",
            s,
            t.elapsed().as_millis(),
            pcm.len() as f64 / r as f64,
            bytes.len() / 1024
        );
    }
}

/// A chat that answers every spoken message with a scripted reply after
/// `first_token`, the way a turn's `text_delta`s arrive.
struct ScriptedChat {
    tx: broadcast::Sender<Event>,
    busy: Arc<AtomicBool>,
    first_token: Duration,
    reply: Vec<&'static str>,
    sent: std::sync::Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Turns for ScriptedChat {
    async fn send_spoken(&self, _chat: Option<&str>, text: &str) -> Result<Handed, String> {
        self.sent.lock().unwrap().push(text.to_string());
        self.busy.store(true, Ordering::SeqCst);
        let tx = self.tx.clone();
        let busy = self.busy.clone();
        let first = self.first_token;
        let reply = self.reply.clone();
        tokio::spawn(async move {
            tokio::time::sleep(first).await;
            for d in reply {
                let _ = tx.send(Event {
                    name: "turn-event".into(),
                    payload: json!({"chat": "c1", "type": "text_delta", "text": d}).to_string(),
                });
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            busy.store(false, Ordering::SeqCst);
        });
        Ok(Handed::Sent)
    }
    async fn state(&self) -> RemoteState {
        RemoteState {
            active_chat: Some("c1".into()),
            busy: self.busy.load(Ordering::SeqCst),
            ..RemoteState::default()
        }
    }
    fn events(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}

#[tokio::test]
#[ignore = "needs bin/voice-setup.sh and NIGHTLOOM_VOICE_TEST=1"]
async fn a_spoken_turn_through_the_socket_session_end_to_end() {
    let Some(dir) = voice_dir() else {
        eprintln!("NIGHTLOOM_VOICE_TEST is not 1: skipped");
        return;
    };
    let engine = Engine::new(Setup::find_in(&dir).expect("voice dir incomplete"));
    let (name, pcm, words) = fixtures(&dir)
        .into_iter()
        .find(|(n, ..)| n == "weather")
        .expect("fixtures/weather.wav");
    let (tx, _) = broadcast::channel(256);
    let chat = Arc::new(ScriptedChat {
        tx,
        busy: Arc::new(AtomicBool::new(false)),
        first_token: Duration::from_millis(1500),
        reply: vec![
            "It's clear and ",
            "about eighteen degrees there. ",
            "Here is how I checked:\n```sh\ncurl wttr.in\n```\n",
            "Nothing else to report.",
        ],
        sent: std::sync::Mutex::new(Vec::new()),
    });
    let (to_host, inbound) = mpsc::channel(1024);
    let (out, mut from_host) = mpsc::channel(1024);
    let mut deps = Deps::with_engine("tok".into(), engine, chat.clone());
    deps.timing = Timing::default();
    let task = tokio::spawn(session::run(deps, inbound, out));

    let t = Instant::now();
    to_host
        .send(Inbound::Text(
            json!({"t":"hello","token":"tok"}).to_string(),
        ))
        .await
        .unwrap();
    // Ready once the models are loaded; audio is sent after it, as the
    // page does once the orb says it is listening.
    loop {
        if let Some(Outbound::Text(f)) = from_host.recv().await
            && f.contains("\"ready\"")
        {
            println!("ready after {} ms: {f}", t.elapsed().as_millis());
            break;
        }
    }
    // At real time, in 20 ms frames, so the partials run as on the phone;
    // then the 2 s of silence the phone's VAD waits for is skipped — the
    // end frame is what the host sees.
    let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    for frame in bytes.chunks(640) {
        tick.tick().await;
        to_host.send(Inbound::Binary(frame.to_vec())).await.unwrap();
    }
    let ended = Instant::now();
    to_host
        .send(Inbound::Text(json!({"t":"end"}).to_string()))
        .await
        .unwrap();

    let mut spoken = Vec::new();
    let mut partials = 0;
    loop {
        let f = tokio::time::timeout(Duration::from_secs(30), from_host.recv())
            .await
            .expect("frames")
            .expect("open");
        let Outbound::Text(t) = f else { continue };
        let v: Value = serde_json::from_str(&t).unwrap();
        match v["t"].as_str().unwrap() {
            "partial" => {
                partials += 1;
                println!("partial: {}", v["text"]);
            }
            "final" => println!(
                "final after {} ms (stt {} ms): {}",
                ended.elapsed().as_millis(),
                v["stt_ms"],
                v["text"]
            ),
            "audio" => {
                if v["seq"] == 0 {
                    let since = v["since_end_ms"].as_u64().unwrap();
                    let first = v["first_text_ms"].as_u64().unwrap();
                    println!(
                        "first audio: {since} ms after the end frame; first text at {first} ms; so {} ms over the turn's own first-token time",
                        since - first
                    );
                    assert!(
                        since - first <= 3000,
                        "the design's budget: 3.0 s plus first-token time"
                    );
                }
                spoken.push(v["sentence"].as_str().unwrap().to_string());
            }
            "reply_end" => break,
            "error" => panic!("{v}"),
            _ => {}
        }
    }
    task.abort();
    println!("{name}: {partials} partials; spoken: {spoken:?}");
    let sent = chat.sent.lock().unwrap().clone();
    assert!(recall(&words, &sent[0]) >= 0.9, "{sent:?}");
    assert_eq!(
        spoken,
        vec![
            "It's clear and about eighteen degrees there.",
            "Here is how I checked:",
            super::split::CODE_ON_SCREEN,
            "Nothing else to report."
        ]
    );
}

#[test]
fn recall_counts_words_in_order_ignoring_case_and_punctuation() {
    assert_eq!(recall("What's the weather?", "what's the weather"), 1.0);
    assert_eq!(recall("a b c d", "a x c d"), 0.75);
}
