//! Manual check of the research-thread upkeep (nightshift backlog 271) on a
//! real thread folder — always a *copy*, since `--apply` rewrites
//! `thread.md` and appends to `archive.md`:
//!
//! ```sh
//! mkdir -p /tmp/vg/.agents/threads && cp -R .agents/threads/stuart-brainstorm /tmp/vg/.agents/threads/
//! cargo run -p nightloom-service --example thread_upkeep -- /tmp/vg/.agents/threads/stuart-brainstorm [--apply] [--today 2026-10-02]
//! ```
//!
//! Prints what the upkeep found (and did, with `--apply`, which also writes
//! `threads/INDEX.md`) as JSON, then the thread layer the folder would load.
//! No model, no network.

use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut dir: Option<PathBuf> = None;
    let mut apply = false;
    let mut today = chrono::Local::now().date_naive();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--apply" => apply = true,
            "--today" => {
                let d = args.next().expect("--today needs a date");
                today = chrono::NaiveDate::parse_from_str(&d, "%Y-%m-%d").expect("YYYY-MM-DD");
            }
            other => dir = Some(PathBuf::from(other)),
        }
    }
    let dir = dir.expect("usage: thread_upkeep <thread dir> [--apply] [--today YYYY-MM-DD]");
    let up = nightloom_service::thread::upkeep(&dir, today, apply).expect("upkeep");
    println!("{}", serde_json::to_string_pretty(&up).expect("json"));
    let slug = dir.file_name().unwrap().to_string_lossy().into_owned();
    let notes = dir
        .parent()
        .and_then(|p| p.parent())
        .expect("a thread dir sits in <docspace>/threads/");
    if apply {
        nightloom_service::thread::write_index(notes).expect("index");
    }
    if let Some(ctx) = nightloom_service::thread::ThreadContext::new(notes, &slug) {
        let seg = nightloom_service::thread::thread_segment(&ctx);
        println!(
            "\n--- thread layer ({} bytes, ~{} tokens) ---\n{}",
            seg.text.len(),
            nightloom_core::estimate_tokens(&seg.text),
            seg.text
        );
    }
}
