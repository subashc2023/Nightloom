//! Item 878: the Rust scoreboard against the Python simulation
//! (`notes/runner-design/aside-cache-hold-sim.py` in nightshift-code).
//!
//! `cargo run -p nightloom-service --example hold_sim_parity -- table <gaps.csv>`
//! prints the walk-forward table over the last 4 weeks of `gaps.csv` (the
//! Python features' file), with Python's NOW (the latest censored end), in
//! the Python script's columns — diff it against its output.
//!
//! `… -- extract <gaps.csv>` reads his own files as the app does and
//! compares the idle moments with `gaps.csv` (made at about the same time).
//!
//! `… -- board` runs the app's scoreboard on his files and prints it
//! without writing anything.
//!
//! No model calls; reads only ids, timestamps and usage numbers.

use nightloom_service::hold_policy::gaps::{self, Gap};
use nightloom_service::hold_policy::sim;

fn split(line: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut q = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if q && chars.peek() == Some(&'"') => {
                chars.next();
                out.last_mut().unwrap().push('"');
            }
            '"' => q = !q,
            ',' if !q => out.push(String::new()),
            c => out.last_mut().unwrap().push(c),
        }
    }
    out
}

fn read_csv(path: &str) -> Vec<Gap> {
    let text = std::fs::read_to_string(path).expect("gaps.csv");
    let mut lines = text.lines();
    let head = split(lines.next().unwrap_or_default());
    let col = |n: &str| head.iter().position(|h| h == n).expect(n);
    let (t0, gm, ce, cx, mo) = (
        col("t0"),
        col("gap_min"),
        col("censored"),
        col("ctx"),
        col("model"),
    );
    let mut rows: Vec<Gap> = lines
        .filter(|l| !l.is_empty())
        .map(split)
        .map(|f| Gap {
            t0: f[t0].parse().unwrap(),
            gap_min: f[gm].parse().unwrap(),
            censored: f[ce] == "1",
            ctx: f[cx].parse().unwrap(),
            fable: f[mo] == gaps::MODELS[1],
        })
        .collect();
    rows.sort_by_key(|g| g.t0);
    rows
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let home = std::env::var("HOME").expect("HOME");
    let config = nightloom_service::project::config_dir().expect("config dir");
    let claude = std::path::PathBuf::from(&home).join(".claude/projects");
    match args.first().map(String::as_str) {
        Some("table") => {
            let rows = read_csv(&args[1]);
            let now = rows
                .iter()
                .filter(|g| g.censored)
                .map(|g| g.t0 as f64 + g.gap_min * 60.0)
                .fold(f64::MIN, f64::max) as i64;
            let (weeks, lines) = sim::walk_forward(&rows, now, 4, 0, None);
            for w in &weeks {
                println!(
                    "fold train {} test {} sleep {}:00-{}:00",
                    w.train, w.test, w.sleep.start, w.sleep.end
                );
            }
            println!(
                "| Policy | Rebuilds avoided | Pings | Net $ (reads at full price) | Net $, reads at 0.5 (580) | 5-hour pts, light | Weekly pts | Weekly pts, light |"
            );
            for l in &lines {
                let t = l.window;
                println!(
                    "| {} | {} | {} | {:.2} | {:.2} | {:.1} | {:.2} | {:.2} |",
                    l.id, t.avoided, t.pings, t.usd, t.half, t.pts_light, t.wk, t.wk_light
                );
            }
        }
        Some("extract") => {
            let csv = read_csv(&args[1]);
            let now = chrono::Utc::now().timestamp();
            let rows = gaps::extract(&config, &claude, gaps::SINCE_S, now);
            let closed = |r: &[Gap]| -> (usize, u64) {
                let c: Vec<&Gap> = r.iter().filter(|g| !g.censored).collect();
                (c.len(), c.iter().map(|g| g.ctx).sum())
            };
            println!("python rows {} closed {:?}", csv.len(), closed(&csv));
            println!("rust   rows {} closed {:?}", rows.len(), closed(&rows));
            let py: std::collections::HashSet<(i64, u64)> =
                csv.iter().map(|g| (g.t0, g.ctx)).collect();
            let rs: std::collections::HashSet<(i64, u64)> =
                rows.iter().map(|g| (g.t0, g.ctx)).collect();
            println!(
                "only python {} only rust {}",
                py.difference(&rs).count(),
                rs.difference(&py).count()
            );
            let mut only: Vec<_> = rs.difference(&py).collect();
            only.sort();
            for (t, c) in only.iter().take(5) {
                println!("  rust only: t0 {t} ctx {c}");
            }
        }
        Some("board") => {
            let now = chrono::Utc::now().timestamp_millis();
            let rows = gaps::extract(&config, &claude, gaps::SINCE_S, now / 1000);
            let active = nightloom_service::hold_policy::active_id(Some(&config));
            let t = std::time::Instant::now();
            let b = sim::scoreboard(&rows, now, &active, None, None);
            println!(
                "{} moments, {} weeks, scored in {:?}",
                b.moments,
                b.weeks.len(),
                t.elapsed()
            );
            println!("{}", serde_json::to_string_pretty(&b).unwrap_or_default());
        }
        _ => eprintln!("usage: hold_sim_parity table|extract <gaps.csv> | board"),
    }
}
