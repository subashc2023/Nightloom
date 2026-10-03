//! One phone's voice socket, independent of the transport (design §2.3).
//!
//! `remote/voice_ws.rs` turns an axum WebSocket into the two channels
//! [`run`] takes, so everything here — the token gate, endpointing's host
//! half, partials, the final pass, the send, the reply spoken sentence by
//! sentence — is tested without a socket.
//!
//! # Frames
//!
//! Text frames are JSON objects tagged by `t`; binary frames are audio.
//!
//! From the phone:
//! - `{"t":"hello","token":…,"chat":…?}` — first, always. A browser
//!   WebSocket cannot send an `Authorization` header and the token must
//!   never ride a URL, so it is the first frame; anything else, or the
//!   wrong token, and the socket is closed before any audio is read.
//! - binary: 16 kHz mono 16-bit little-endian PCM, while he talks.
//! - `{"t":"end"}` — the phone's VAD heard the pause (2 s by default).
//! - `{"t":"cancel"}` — forget the utterance in progress.
//! - `{"t":"hush"}` — barge-in: he spoke over the reply; stop speaking it
//!   (the text keeps streaming on screen).
//! - `{"t":"unqueue"}` — drop the message held behind the running turn.
//! - `{"t":"chat","chat":…}` — speak into another chat from now on.
//! - `{"t":"speak","text":…}` — "Speak it" (wave 3 B2, design §2.6): read
//!   this text aloud through the same voice, as reply audio — `audio`
//!   frames from sequence 0, then `reply_end`. The page sends the last
//!   reply's prose when it comes back from the background after the reply
//!   finished; nothing is sent to the chat. Refused with an `error` while
//!   a spoken turn's reply is still coming (that reply is spoken as it
//!   arrives); `hush` stops it as it stops a reply. Over
//!   [`MAX_SPEAK_CHARS`] the rest is cut at a character boundary.
//!
//! From the host:
//! - `{"t":"ready","chat","sample_rate","mic_rate"}` after the hello.
//! - `{"t":"partial","text"}` every ~700 ms while he talks.
//! - `{"t":"final","text","stt_ms"}` the words that will be sent.
//! - `{"t":"dropped","reason":"short"|"noise","text"}` never sent.
//! - `{"t":"held","text"}` — a turn is running: this (merged with what
//!   was held before, blocker 664's default) goes when it ends.
//! - `{"t":"sent","status":"sent"|"queued"}` — handed to the chat.
//! - `{"t":"audio","seq","sentence",…}` then one binary frame, a WAV.
//!   Sequence 0 also carries `since_end_ms` (end-of-speech frame to this
//!   audio) and `first_text_ms` (end-of-speech to the reply's first text):
//!   the latency the design budgets, logged on every spoken turn.
//! - `{"t":"reply_end"}` — the turn is over.
//! - `{"t":"error","text","message"?}` — `message` is his words when it
//!   was the send that failed, so the page can keep them.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use super::split::Splitter;
use super::{Engine, Hear, MIC_RATE, MIN_UTTERANCE, Pass, Speak, is_noise, wav};
use crate::remote::{Event, Handed, RemoteState, token};

/// A frame from the phone.
#[derive(Debug)]
pub enum Inbound {
    Text(String),
    Binary(Vec<u8>),
}

/// A frame to the phone.
#[derive(Debug, PartialEq)]
pub enum Outbound {
    Text(String),
    Binary(Vec<u8>),
    /// Close the socket (after a refused hello).
    Close,
}

/// What a voice socket needs of the chat side: the host's send with
/// `spoken`, its state, and its event relay. `remote/voice_ws.rs` adapts
/// the listener's [`Host`](crate::remote::Host) to it.
#[async_trait::async_trait]
pub trait Turns: Send + Sync {
    async fn send_spoken(&self, chat: Option<&str>, text: &str) -> Result<Handed, String>;
    async fn state(&self) -> RemoteState;
    fn events(&self) -> broadcast::Receiver<Event>;
}

/// The clocks, shortened by tests.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// How often a partial is transcribed while he talks.
    pub partial_every: Duration,
    /// How often a running turn's `busy` is read, to see it end.
    pub poll_every: Duration,
    /// How long the phone has to say hello.
    pub hello_wait: Duration,
    /// A send whose turn never shows as running is over after this.
    pub never_started: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            partial_every: Duration::from_millis(700),
            poll_every: Duration::from_millis(500),
            hello_wait: Duration::from_secs(10),
            never_started: Duration::from_secs(15),
        }
    }
}

/// Everything one socket runs on.
pub struct Deps {
    pub token: String,
    pub hear: Arc<dyn Hear>,
    pub speak: Arc<dyn Speak>,
    pub turns: Arc<dyn Turns>,
    /// Started at the hello so the models load while he starts talking;
    /// `None` in tests.
    pub warm: Option<Arc<Engine>>,
    pub timing: Timing,
}

impl Deps {
    /// The real engine for both halves.
    pub fn with_engine(token: String, engine: Arc<Engine>, turns: Arc<dyn Turns>) -> Self {
        Self {
            token,
            hear: engine.clone(),
            speak: engine.clone(),
            turns,
            warm: Some(engine),
            timing: Timing::default(),
        }
    }
}

fn frame(v: Value) -> Outbound {
    Outbound::Text(v.to_string())
}

/// The longest text a `speak` frame reads aloud (~5 minutes of speech):
/// a reply longer than that is better read on screen.
pub const MAX_SPEAK_CHARS: usize = 6000;

/// The sentences a `speak` frame's text becomes — the reply splitter's,
/// so a code block is "I've put the code on screen." here too.
fn speak_lines(text: &str) -> Vec<String> {
    let cut: String = text.chars().take(MAX_SPEAK_CHARS).collect();
    let mut s = Splitter::new();
    let mut out = s.push(&cut);
    out.extend(s.push("\n"));
    out.extend(s.finish());
    out
}

/// A transcription's result, back from its task.
enum Heard {
    Partial {
        utterance: u64,
        text: Result<String, String>,
    },
    Final {
        text: Result<String, String>,
        stt_ms: u128,
        ended: Instant,
    },
}

/// One sentence for the speaking task.
struct Line {
    reply: u64,
    seq: u64,
    sentence: String,
    /// The end-of-speech frame this reply answers, and when its first
    /// text arrived: sequence 0 reports both.
    ended: Option<Instant>,
    first_text: Option<Instant>,
}

/// Run one socket until the phone goes. Returns when `inbound` closes or
/// the hello is refused.
pub async fn run(deps: Deps, mut inbound: mpsc::Receiver<Inbound>, out: mpsc::Sender<Outbound>) {
    // ---- the gate: nothing but a matching hello opens the socket --------
    let hello = tokio::time::timeout(deps.timing.hello_wait, inbound.recv()).await;
    let chat = match hello {
        Ok(Some(Inbound::Text(t))) => match serde_json::from_str::<Value>(&t) {
            Ok(v)
                if v["t"] == "hello"
                    && token::matches(&deps.token, v["token"].as_str().unwrap_or("")) =>
            {
                v["chat"].as_str().map(str::to_string)
            }
            _ => return refuse(&out).await,
        },
        _ => return refuse(&out).await,
    };
    let mut chat = match chat {
        Some(c) => Some(c),
        None => deps.turns.state().await.active_chat,
    };
    let sample_rate = match &deps.warm {
        Some(engine) => match engine.warm().await {
            Ok(rate) => Some(rate),
            Err(e) => {
                let _ = out
                    .send(frame(
                        json!({"t": "error", "text": format!("voice could not start: {e}")}),
                    ))
                    .await;
                let _ = out.send(Outbound::Close).await;
                return;
            }
        },
        None => None,
    };
    let _ = out
        .send(frame(json!({
            "t": "ready",
            "chat": chat,
            "sample_rate": sample_rate,
            "mic_rate": MIC_RATE,
        })))
        .await;

    // ---- the speaking task ----------------------------------------------
    let current_reply = Arc::new(AtomicU64::new(0));
    let (say_tx, say_rx) = mpsc::unbounded_channel::<Line>();
    let speaker = tokio::spawn(speak_loop(
        deps.speak.clone(),
        say_rx,
        out.clone(),
        current_reply.clone(),
    ));

    let (heard_tx, mut heard_rx) = mpsc::unbounded_channel::<Heard>();
    let mut events = deps.turns.events();
    let mut partial_tick = tokio::time::interval(deps.timing.partial_every);
    let mut poll_tick = tokio::time::interval(deps.timing.poll_every);

    // The utterance being heard.
    let mut utter: Vec<i16> = Vec::new();
    let mut utterance: u64 = 0;
    let mut partial_inflight = false;
    let mut partial_len = 0usize;
    // The reply being spoken.
    let mut replying = false;
    let mut seen_running = false;
    let mut sent_at = Instant::now();
    let mut hushed = false;
    let mut splitter = Splitter::new();
    let mut seq: u64 = 0;
    let mut ended: Option<Instant> = None;
    let mut first_text: Option<Instant> = None;
    let mut held: Option<String> = None;

    loop {
        tokio::select! {
            msg = inbound.recv() => {
                let Some(msg) = msg else { break };
                match msg {
                    Inbound::Binary(bytes) => utter.extend(wav::samples(&bytes)),
                    Inbound::Text(t) => {
                        let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                        match v["t"].as_str().unwrap_or("") {
                            "end" => {
                                let pcm = std::mem::take(&mut utter);
                                utterance += 1;
                                partial_len = 0;
                                let now = Instant::now();
                                let dur = Duration::from_secs_f64(pcm.len() as f64 / MIC_RATE as f64);
                                if dur < MIN_UTTERANCE {
                                    let _ = out.send(frame(json!({"t": "dropped", "reason": "short", "text": ""}))).await;
                                    continue;
                                }
                                let hear = deps.hear.clone();
                                let tx = heard_tx.clone();
                                tokio::spawn(async move {
                                    let t0 = Instant::now();
                                    let text = hear.transcribe(&pcm, Pass::Final).await;
                                    let _ = tx.send(Heard::Final { text, stt_ms: t0.elapsed().as_millis(), ended: now });
                                });
                            }
                            "cancel" => {
                                utter.clear();
                                utterance += 1;
                                partial_len = 0;
                            }
                            "hush" => {
                                if replying {
                                    hushed = true;
                                }
                                // A reply, or a `speak` being read: either
                                // stops (a later reply takes a new number).
                                current_reply.fetch_add(1, Ordering::SeqCst);
                            }
                            "speak" => {
                                let text = v["text"].as_str().unwrap_or("").trim();
                                if replying {
                                    let _ = out.send(frame(json!({"t": "error", "text": "a reply is still coming — it is spoken as it arrives"}))).await;
                                    continue;
                                }
                                let lines = speak_lines(text);
                                if lines.is_empty() {
                                    let _ = out.send(frame(json!({"t": "error", "text": "nothing to speak in that reply"}))).await;
                                    continue;
                                }
                                // Its own number: a hush, or another speak,
                                // drops what is left of this one.
                                let reply = current_reply.fetch_add(1, Ordering::SeqCst) + 1;
                                for (n, sentence) in lines.into_iter().enumerate() {
                                    let _ = say_tx.send(Line { reply, seq: n as u64, sentence, ended: None, first_text: None });
                                }
                                let _ = say_tx.send(Line { reply: u64::MAX, seq: 0, sentence: String::new(), ended: None, first_text: None });
                            }
                            "unqueue" => {
                                held = None;
                                let _ = out.send(frame(json!({"t": "held", "text": Value::Null}))).await;
                            }
                            "chat" => {
                                chat = v["chat"].as_str().map(str::to_string);
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ = partial_tick.tick() => {
                // Half a second of new speech since the last partial, and
                // none in flight: whisper the utterance so far.
                if !partial_inflight && utter.len() >= partial_len + (MIC_RATE as usize / 2) {
                    partial_inflight = true;
                    partial_len = utter.len();
                    let pcm = utter.clone();
                    let hear = deps.hear.clone();
                    let tx = heard_tx.clone();
                    let n = utterance;
                    tokio::spawn(async move {
                        let text = hear.transcribe(&pcm, Pass::Partial).await;
                        let _ = tx.send(Heard::Partial { utterance: n, text });
                    });
                }
            }
            Some(heard) = heard_rx.recv() => match heard {
                Heard::Partial { utterance: n, text } => {
                    partial_inflight = false;
                    if n == utterance && let Ok(text) = text && !is_noise(&text) {
                        let _ = out.send(frame(json!({"t": "partial", "text": text}))).await;
                    }
                }
                Heard::Final { text, stt_ms, ended: at } => {
                    let text = match text {
                        Ok(t) => t,
                        Err(e) => {
                            let _ = out.send(frame(json!({"t": "error", "text": format!("could not transcribe: {e}")}))).await;
                            continue;
                        }
                    };
                    if is_noise(&text) {
                        let _ = out.send(frame(json!({"t": "dropped", "reason": "noise", "text": text}))).await;
                        continue;
                    }
                    let _ = out.send(frame(json!({"t": "final", "text": text, "stt_ms": stt_ms}))).await;
                    if replying {
                        let merged = match held.take() {
                            Some(h) => format!("{h} {text}"),
                            None => text,
                        };
                        let _ = out.send(frame(json!({"t": "held", "text": merged}))).await;
                        held = Some(merged);
                        continue;
                    }
                    if send_now(&deps, chat.as_deref(), &text, &out).await {
                        replying = true;
                        seen_running = false;
                        sent_at = Instant::now();
                        hushed = false;
                        splitter = Splitter::new();
                        seq = 0;
                        ended = Some(at);
                        first_text = None;
                        current_reply.fetch_add(1, Ordering::SeqCst);
                    }
                }
            },
            ev = events.recv() => {
                let ev = match ev {
                    Ok(ev) => ev,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        // The relay is gone (the listener stopping); keep
                        // hearing, but nothing more will be spoken.
                        events = deps.turns.events();
                        continue;
                    }
                };
                if !replying || ev.name != "turn-event" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&ev.payload) else { continue };
                if let (Some(ours), Some(theirs)) = (chat.as_deref(), v["chat"].as_str())
                    && ours != theirs
                {
                    continue;
                }
                seen_running = true;
                let sentences = match v["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        if first_text.is_none() {
                            first_text = Some(Instant::now());
                        }
                        splitter.push(v["text"].as_str().unwrap_or(""))
                    }
                    "tool_call" => splitter.flush(),
                    _ => Vec::new(),
                };
                if !hushed {
                    for s in sentences {
                        let _ = say_tx.send(Line {
                            reply: current_reply.load(Ordering::SeqCst),
                            seq,
                            sentence: s,
                            ended,
                            first_text,
                        });
                        seq += 1;
                    }
                }
            }
            _ = poll_tick.tick(), if replying => {
                let busy = deps.turns.state().await.busy;
                if busy {
                    seen_running = true;
                    continue;
                }
                if !seen_running && sent_at.elapsed() < deps.timing.never_started {
                    continue;
                }
                // The turn is over: the last words, then the held message.
                let rest = splitter.finish();
                if !hushed {
                    for s in rest {
                        let _ = say_tx.send(Line {
                            reply: current_reply.load(Ordering::SeqCst),
                            seq,
                            sentence: s,
                            ended,
                            first_text,
                        });
                        seq += 1;
                    }
                }
                replying = false;
                let _ = say_tx.send(Line { reply: u64::MAX, seq: 0, sentence: String::new(), ended: None, first_text: None });
                if let Some(text) = held.take()
                    && send_now(&deps, chat.as_deref(), &text, &out).await
                {
                    replying = true;
                    seen_running = false;
                    sent_at = Instant::now();
                    hushed = false;
                    splitter = Splitter::new();
                    seq = 0;
                    ended = Some(Instant::now());
                    first_text = None;
                    current_reply.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
    }
    speaker.abort();
}

async fn refuse(out: &mpsc::Sender<Outbound>) {
    let _ = out
        .send(frame(json!({
            "t": "error",
            "text": "the token is missing or wrong — open the link from Settings → Remote again",
        })))
        .await;
    let _ = out.send(Outbound::Close).await;
}

/// Hand `text` to the chat; say what became of it. `true` when it went.
async fn send_now(
    deps: &Deps,
    chat: Option<&str>,
    text: &str,
    out: &mpsc::Sender<Outbound>,
) -> bool {
    match deps.turns.send_spoken(chat, text).await {
        Ok(status) => {
            let _ = out
                .send(frame(json!({"t": "sent", "status": status})))
                .await;
            true
        }
        Err(e) => {
            let _ = out
                .send(frame(json!({"t": "error", "text": e, "message": text})))
                .await;
            false
        }
    }
}

/// Speak each line in order; skip a line whose reply was hushed. A line
/// with reply `u64::MAX` is the turn's end, said after its last audio.
async fn speak_loop(
    speak: Arc<dyn Speak>,
    mut rx: mpsc::UnboundedReceiver<Line>,
    out: mpsc::Sender<Outbound>,
    current: Arc<AtomicU64>,
) {
    while let Some(line) = rx.recv().await {
        if line.reply == u64::MAX {
            let _ = out.send(frame(json!({"t": "reply_end"}))).await;
            continue;
        }
        if line.reply != current.load(Ordering::SeqCst) {
            continue;
        }
        let wav = match speak.speak(&line.sentence).await {
            Ok(wav) => wav,
            Err(e) => {
                let _ = out
                    .send(frame(
                        json!({"t": "error", "text": format!("could not speak: {e}")}),
                    ))
                    .await;
                continue;
            }
        };
        // Hushed while it was being made: drop it.
        if line.reply != current.load(Ordering::SeqCst) {
            continue;
        }
        let mut head =
            json!({"t": "audio", "seq": line.seq, "sentence": line.sentence, "bytes": wav.len()});
        if line.seq == 0
            && let Some(ended) = line.ended
        {
            head["since_end_ms"] = json!(ended.elapsed().as_millis());
            head["first_text_ms"] =
                json!(line.first_text.map(|t| t.duration_since(ended).as_millis()));
        }
        let _ = out.send(frame(head)).await;
        let _ = out.send(Outbound::Binary(wav)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeEar;
    #[async_trait::async_trait]
    impl Hear for FakeEar {
        async fn transcribe(&self, pcm: &[i16], pass: Pass) -> Result<String, String> {
            // The "words" are the first sample's value, so a test chooses
            // what is heard by what it sends.
            let words = match pcm.first().copied().unwrap_or(0) {
                1 => "what is the weather",
                2 => "thank you",
                3 => "and tomorrow",
                _ => "something else",
            };
            Ok(match pass {
                Pass::Partial => format!("{words}…"),
                Pass::Final => words.to_string(),
            })
        }
    }

    struct FakeMouth;
    #[async_trait::async_trait]
    impl Speak for FakeMouth {
        async fn speak(&self, text: &str) -> Result<Vec<u8>, String> {
            Ok(text.as_bytes().to_vec())
        }
    }

    #[derive(Default)]
    struct FakeTurns {
        sent: Mutex<Vec<(Option<String>, String)>>,
        busy: std::sync::atomic::AtomicBool,
        tx: Mutex<Option<broadcast::Sender<Event>>>,
    }
    #[async_trait::async_trait]
    impl Turns for FakeTurns {
        async fn send_spoken(&self, chat: Option<&str>, text: &str) -> Result<Handed, String> {
            self.sent
                .lock()
                .unwrap()
                .push((chat.map(str::to_string), text.to_string()));
            self.busy.store(true, Ordering::SeqCst);
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
            self.tx.lock().unwrap().as_ref().unwrap().subscribe()
        }
    }

    struct Rig {
        to_host: mpsc::Sender<Inbound>,
        from_host: mpsc::Receiver<Outbound>,
        turns: Arc<FakeTurns>,
        relay: broadcast::Sender<Event>,
        task: tokio::task::JoinHandle<()>,
    }

    fn rig() -> Rig {
        let (relay, _) = broadcast::channel(64);
        let turns = Arc::new(FakeTurns::default());
        *turns.tx.lock().unwrap() = Some(relay.clone());
        let (to_host, inbound) = mpsc::channel(64);
        let (out, from_host) = mpsc::channel(256);
        let deps = Deps {
            token: "secret".into(),
            hear: Arc::new(FakeEar),
            speak: Arc::new(FakeMouth),
            turns: turns.clone(),
            warm: None,
            timing: Timing {
                partial_every: Duration::from_millis(20),
                poll_every: Duration::from_millis(20),
                hello_wait: Duration::from_millis(300),
                never_started: Duration::from_millis(500),
            },
        };
        let task = tokio::spawn(run(deps, inbound, out));
        Rig {
            to_host,
            from_host,
            turns,
            relay,
            task,
        }
    }

    impl Rig {
        async fn say(&self, v: Value) {
            self.to_host
                .send(Inbound::Text(v.to_string()))
                .await
                .unwrap();
        }
        /// Speech whose first sample picks the words, `ms` long.
        async fn speech(&self, word: i16, ms: usize) {
            let mut pcm = vec![word];
            pcm.resize(MIC_RATE as usize * ms / 1000, 100);
            let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
            // In 20 ms frames, as the phone sends them.
            for chunk in bytes.chunks(640) {
                self.to_host
                    .send(Inbound::Binary(chunk.to_vec()))
                    .await
                    .unwrap();
            }
        }
        /// The next text frame whose `t` is `kind`, skipping others.
        async fn until(&mut self, kind: &str) -> Value {
            loop {
                let f = tokio::time::timeout(Duration::from_secs(3), self.from_host.recv())
                    .await
                    .unwrap_or_else(|_| panic!("no {kind} frame"))
                    .unwrap_or_else(|| panic!("socket closed before {kind}"));
                if let Outbound::Text(t) = f {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["t"] == kind {
                        return v;
                    }
                }
            }
        }
        fn delta(&self, text: &str) {
            let _ = self.relay.send(Event {
                name: "turn-event".into(),
                payload: json!({"chat": "c1", "type": "text_delta", "text": text}).to_string(),
            });
        }
        async fn hello(&mut self) {
            self.say(json!({"t": "hello", "token": "secret"})).await;
            let ready = self.until("ready").await;
            assert_eq!(ready["chat"], "c1", "no chat named: the open one");
            assert_eq!(ready["mic_rate"], 16_000);
        }
    }

    #[tokio::test]
    async fn a_wrong_token_closes_the_socket_before_any_audio_is_read() {
        let mut r = rig();
        r.say(json!({"t": "hello", "token": "guess"})).await;
        let err = r.until("error").await;
        assert!(err["text"].as_str().unwrap().contains("token"));
        assert_eq!(r.from_host.recv().await, Some(Outbound::Close));
        // The session is over: audio after it goes nowhere.
        r.task.await.unwrap();
        assert!(r.to_host.send(Inbound::Binary(vec![0; 640])).await.is_err());
        assert!(r.turns.sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn audio_before_the_hello_is_refused_too() {
        let mut r = rig();
        r.to_host
            .send(Inbound::Binary(vec![1, 0, 0, 0]))
            .await
            .unwrap();
        r.until("error").await;
        assert_eq!(r.from_host.recv().await, Some(Outbound::Close));
    }

    #[tokio::test]
    async fn no_hello_at_all_times_out_and_closes() {
        let mut r = rig();
        r.until("error").await;
        assert_eq!(r.from_host.recv().await, Some(Outbound::Close));
    }

    #[tokio::test]
    async fn speech_is_heard_sent_spoken_and_the_reply_is_spoken_back_in_order() {
        let mut r = rig();
        r.hello().await;
        r.speech(1, 1200).await;
        let partial = r.until("partial").await;
        assert_eq!(partial["text"], "what is the weather…");
        r.say(json!({"t": "end"})).await;
        let fin = r.until("final").await;
        assert_eq!(fin["text"], "what is the weather");
        assert_eq!(r.until("sent").await["status"], "sent");
        assert_eq!(
            *r.turns.sent.lock().unwrap(),
            vec![(Some("c1".to_string()), "what is the weather".to_string())]
        );
        r.delta("It is sun");
        r.delta("ny. Warm too");
        let a0 = r.until("audio").await;
        assert_eq!(
            (a0["seq"].as_u64(), a0["sentence"].as_str()),
            (Some(0), Some("It is sunny."))
        );
        assert!(a0["since_end_ms"].is_u64() && a0["first_text_ms"].is_u64());
        assert_eq!(
            r.from_host.recv().await,
            Some(Outbound::Binary(b"It is sunny.".to_vec()))
        );
        r.delta(".\n```\ncode\n```\n");
        let a1 = r.until("audio").await;
        assert_eq!(a1["sentence"], "Warm too.");
        let a2 = r.until("audio").await;
        assert_eq!(a2["sentence"], crate::voice::split::CODE_ON_SCREEN);
        r.turns.busy.store(false, Ordering::SeqCst);
        r.until("reply_end").await;
    }

    #[tokio::test]
    async fn short_sounds_and_whispers_noise_are_never_sent() {
        let mut r = rig();
        r.hello().await;
        r.speech(1, 200).await;
        r.say(json!({"t": "end"})).await;
        assert_eq!(r.until("dropped").await["reason"], "short");
        r.speech(2, 900).await;
        r.say(json!({"t": "end"})).await;
        assert_eq!(r.until("dropped").await["reason"], "noise");
        assert!(r.turns.sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn speech_during_a_turn_is_held_merged_and_sent_when_it_ends() {
        let mut r = rig();
        r.hello().await;
        r.speech(1, 800).await;
        r.say(json!({"t": "end"})).await;
        r.until("sent").await;
        // Two more utterances while the reply runs: one held message.
        r.speech(3, 800).await;
        r.say(json!({"t": "end"})).await;
        assert_eq!(r.until("held").await["text"], "and tomorrow");
        r.speech(4, 800).await;
        r.say(json!({"t": "end"})).await;
        assert_eq!(r.until("held").await["text"], "and tomorrow something else");
        assert_eq!(r.turns.sent.lock().unwrap().len(), 1);
        r.turns.busy.store(false, Ordering::SeqCst);
        // The turn's end and the held message's send, in either order:
        // the end rides behind the reply's last audio, the send does not.
        let mut seen = (false, false);
        while seen != (true, true) {
            let f = tokio::time::timeout(Duration::from_secs(3), r.from_host.recv())
                .await
                .expect("reply_end and sent")
                .expect("open");
            if let Outbound::Text(t) = f {
                let v: Value = serde_json::from_str(&t).unwrap();
                seen.0 |= v["t"] == "reply_end";
                seen.1 |= v["t"] == "sent";
            }
        }
        let sent = r.turns.sent.lock().unwrap().clone();
        assert_eq!(sent[1].1, "and tomorrow something else");
    }

    #[tokio::test]
    async fn a_held_message_can_be_taken_back() {
        let mut r = rig();
        r.hello().await;
        r.speech(1, 800).await;
        r.say(json!({"t": "end"})).await;
        r.until("sent").await;
        r.speech(3, 800).await;
        r.say(json!({"t": "end"})).await;
        r.until("held").await;
        r.say(json!({"t": "unqueue"})).await;
        assert!(r.until("held").await["text"].is_null());
        r.turns.busy.store(false, Ordering::SeqCst);
        r.until("reply_end").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(r.turns.sent.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn barge_in_stops_the_speaking_but_not_the_turn() {
        let mut r = rig();
        r.hello().await;
        r.speech(1, 800).await;
        r.say(json!({"t": "end"})).await;
        r.until("sent").await;
        r.delta("First sentence. ");
        assert_eq!(r.until("audio").await["seq"], 0);
        r.say(json!({"t": "hush"})).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        r.delta("Second sentence. Third. ");
        r.turns.busy.store(false, Ordering::SeqCst);
        // The turn still ends, and nothing after the hush was spoken.
        loop {
            match tokio::time::timeout(Duration::from_secs(3), r.from_host.recv()).await {
                Ok(Some(Outbound::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    assert_ne!(v["t"], "audio", "spoken after the hush: {v}");
                    if v["t"] == "reply_end" {
                        break;
                    }
                }
                Ok(Some(_)) => {}
                other => panic!("no reply_end: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn another_chats_stream_is_not_spoken() {
        let mut r = rig();
        r.hello().await;
        r.speech(1, 800).await;
        r.say(json!({"t": "end"})).await;
        r.until("sent").await;
        let _ = r.relay.send(Event {
            name: "turn-event".into(),
            payload: json!({"chat": "other", "type": "text_delta", "text": "Not mine. "})
                .to_string(),
        });
        r.delta("Mine. ");
        assert_eq!(r.until("audio").await["sentence"], "Mine.");
    }

    /// Text frames until `reply_end`, the audio headers' sentences in
    /// order, each checked against the WAV after it (the stub speaks a
    /// sentence as its own bytes).
    async fn spoken_until_end(r: &mut Rig) -> Vec<(u64, String)> {
        let mut said = Vec::new();
        loop {
            let f = tokio::time::timeout(Duration::from_secs(3), r.from_host.recv())
                .await
                .expect("no reply_end")
                .expect("socket closed");
            let Outbound::Text(t) = f else { continue };
            let v: Value = serde_json::from_str(&t).unwrap();
            match v["t"].as_str().unwrap() {
                "audio" => {
                    let s = v["sentence"].as_str().unwrap().to_string();
                    assert_eq!(
                        r.from_host.recv().await,
                        Some(Outbound::Binary(s.as_bytes().to_vec()))
                    );
                    said.push((v["seq"].as_u64().unwrap(), s));
                }
                "reply_end" => return said,
                other => panic!("unexpected frame {other}: {v}"),
            }
        }
    }

    #[tokio::test]
    async fn speak_reads_a_given_text_aloud_as_reply_audio_and_sends_nothing() {
        let mut r = rig();
        r.hello().await;
        r.say(json!({"t": "speak", "text": "The fix is in. Set the width:\n```css\n.a { min-width: 0 }\n```\nThat is all."})).await;
        let said = spoken_until_end(&mut r).await;
        assert_eq!(
            said,
            vec![
                (0, "The fix is in.".to_string()),
                (1, "Set the width:".to_string()),
                (2, crate::voice::split::CODE_ON_SCREEN.to_string()),
                (3, "That is all.".to_string()),
            ]
        );
        assert!(
            r.turns.sent.lock().unwrap().is_empty(),
            "a speak is never a message"
        );
        // Again: a second speak starts from sequence 0 too.
        r.say(json!({"t": "speak", "text": "Once more."})).await;
        assert_eq!(
            spoken_until_end(&mut r).await,
            vec![(0, "Once more.".to_string())]
        );
    }

    #[tokio::test]
    async fn speak_is_refused_while_a_reply_is_coming_and_when_empty() {
        let mut r = rig();
        r.hello().await;
        r.say(json!({"t": "speak", "text": "   "})).await;
        assert!(
            r.until("error").await["text"]
                .as_str()
                .unwrap()
                .contains("nothing to speak")
        );
        r.speech(1, 800).await;
        r.say(json!({"t": "end"})).await;
        r.until("sent").await;
        r.say(json!({"t": "speak", "text": "Not now."})).await;
        assert!(
            r.until("error").await["text"]
                .as_str()
                .unwrap()
                .contains("still coming")
        );
        // The turn's own reply is still spoken.
        r.delta("Mine. ");
        assert_eq!(r.until("audio").await["sentence"], "Mine.");
    }

    #[test]
    fn a_long_speak_is_cut_at_a_character_boundary() {
        let long = "é".repeat(MAX_SPEAK_CHARS + 50) + ".";
        let lines = speak_lines(&long);
        let total: usize = lines.iter().map(|l| l.chars().count()).sum();
        assert!(total <= MAX_SPEAK_CHARS, "{total}");
    }

    #[tokio::test]
    async fn a_cancelled_utterance_is_forgotten() {
        let mut r = rig();
        r.hello().await;
        r.speech(1, 800).await;
        r.say(json!({"t": "cancel"})).await;
        r.say(json!({"t": "end"})).await;
        assert_eq!(r.until("dropped").await["reason"], "short");
    }
}
