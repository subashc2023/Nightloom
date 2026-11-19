//! Item 794's end-to-end check, outside the app: the run message a watch
//! sends, and the entry its reply becomes — the same functions the job
//! runs (`jobs::watch`). Writes only the note path it is given.
//!
//! `cargo run -p nightloom-service --example watch_run -- message <note> <topic> > msg.txt`
//! `claude -p --output-format stream-json --verbose … < msg.txt > run.jsonl`
//! `cargo run -p nightloom-service --example watch_run -- entry <note> <topic> msg.txt run.jsonl`

use nightloom_service::jobs::watch;

const INSTRUCTIONS: &str = "Keep my research note on this topic current. Check the literature, the pages listed and the news for anything new since the note's last entry, and record only what is new, each claim with the page you opened for it.";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mode, note, topic) = (&args[0], std::path::PathBuf::from(&args[1]), &args[2]);
    let w = watch::Watch {
        topic: topic.clone(),
        sources: Vec::new(),
        note: "watch-check.md".into(),
    };
    let zone = jiff::tz::TimeZone::get("America/Los_Angeles").expect("zone");
    let now = chrono::Utc::now();
    if mode == "message" {
        print!(
            "{}",
            watch::run_text(
                INSTRUCTIONS,
                &w,
                &watch::tail(&note),
                &watch::stamp(now, &zone)
            )
        );
        return;
    }
    let sent = std::fs::read_to_string(&args[3]).expect("the message");
    // `claude -p`'s stream: assistant messages carry `message.content`
    // blocks; shape them as the chat log the job reads.
    let mut events = vec![serde_json::json!({"event": "user_message", "text": sent})];
    let mut reply = String::new();
    for line in std::fs::read_to_string(&args[4]).expect("the run").lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v["type"] == "assistant" {
            events.push(serde_json::json!({"event": "assistant_message", "blocks": v["message"]["content"]}));
        }
        if v["type"] == "result"
            && let Some(r) = v["result"].as_str()
        {
            reply = r.to_string();
        }
    }
    let opened = watch::opened_in(&events, INSTRUCTIONS);
    let e = watch::entry(&reply, &opened, &watch::stamp(now, &zone));
    watch::append(&note, "Watch — check", topic, &e).expect("the note");
    println!(
        "opened {} page(s); changed {}; {} verified, {} unverified; headline: {}",
        opened.len(),
        e.changed,
        e.verified,
        e.unverified,
        e.headline
    );
}
