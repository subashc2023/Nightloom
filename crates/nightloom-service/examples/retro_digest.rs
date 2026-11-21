//! Item 796's trial: the no-model digest of past Claude Code transcripts,
//! with sizes and timings only — nothing of the chat's words is printed.
//!
//! `cargo run -p nightloom-service --example retro_digest -- <transcript.jsonl>…`
//!
//! Per file: its size, the digest's counts, how long the digest took, and
//! what the one review pass would cost at the rates table's prices — the
//! chat's largest context read back from cache, the digest as new input
//! written to the 5-minute cache, and ~3k tokens of answer (an estimate;
//! no model is called here).

use nightloom_service::retrospective::{digest_file, rates, render, review_prompt};
use std::time::Instant;

fn main() {
    let rates = rates();
    for arg in std::env::args().skip(1) {
        let path = std::path::Path::new(&arg);
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let t0 = Instant::now();
        let d = match digest_file(path, rates.as_ref()) {
            Ok(d) => d,
            Err(e) => {
                println!("{arg}: {e}");
                continue;
            }
        };
        let md = render(&d);
        let prompt = review_prompt(&md);
        let ms = t0.elapsed().as_millis();
        let prompt_tokens = prompt.chars().count() as u64 / 4;
        let model = "claude-opus-5-5";
        let est = rates.as_ref().and_then(|r| {
            let m = r.models.get(model)?;
            let read = d.peak_context as f64 * m.input * m.cache_read_mult;
            let write = prompt_tokens as f64 * m.input * r.write_mult_5m;
            let out = 3_000.0 * m.output;
            Some((read + write + out) / 1e6)
        });
        let errors = d.issues.iter().filter(|i| i.kind == "error").count();
        let stops = d.corrections.iter().filter(|c| c.interrupt).count();
        println!(
            "{name}: {mb:.1} MB, {lines} lines, {req} requests, peak {peak} tok, his msgs {his}, \
             errors {errors}, denials {den}, repeats {rep}, misses {mis} ({unexp} not expired, ${mc:.2}), \
             tools {tools}, helpers {helpers}, reads {reads}, corrections {corr} (+{stops} stops), \
             cli cost {cost}, digest {dmd} chars / prompt ~{pt} tok, {ms} ms, review pass est {est}",
            name = d.transcript.chars().take(8).collect::<String>(),
            mb = size as f64 / 1e6,
            lines = d.lines,
            req = d.requests,
            peak = d.peak_context,
            his = d.his_messages,
            den = d.issues.len() - errors,
            rep = d.repeats.len(),
            mis = d.misses.len(),
            unexp = d.misses.iter().filter(|m| !m.expired).count(),
            mc = d.miss_cost_usd,
            tools = d.by_tool.len(),
            helpers = d.helpers.len(),
            reads = d.reads.len(),
            corr = d.corrections.len() - stops,
            cost = d
                .cost_usd
                .map(|c| format!("${c:.2}"))
                .unwrap_or_else(|| "-".into()),
            dmd = md.chars().count(),
            pt = prompt_tokens,
            est = est
                .map(|c| format!("${c:.2}"))
                .unwrap_or_else(|| "unpriced".into()),
        );
    }
}
