//! `nightloom council-trial`: the experiment that decides whether the
//! council is built into the app (nightshift backlog 149, blocker 245;
//! the design note's §6).
//!
//! One of his past dumps — the first user turn of a chat, or a file — is
//! answered three ways, and he judges blind:
//!
//! - **(i) single**: one turn of one model, the dump alone;
//! - **(ii) council**: the seats in parallel (cold: there is no warm chat
//!   here to fork), then the chair over the anonymised, shuffled answers;
//! - **(iii) in-context**: one turn of the single model told to answer as
//!   N area-assigned members and then chair itself — the strong
//!   single-agent baseline at about a third of the council's cost.
//!
//! The three answers land as `answer-A.md`, `answer-B.md`, `answer-C.md`
//! in a shuffled order, with the map in `key.sealed.json` — he reads the
//! three, writes his pick into `judge.md`, and only then opens the key.
//! `metrics.json` records what a person cannot judge: tokens, the cost
//! estimate, wall-clock, lengths, source overlap, and the sources the
//! council's chair cited that the single turn did not. `--tally <dir>`
//! sums the judged runs. No model judges anything here.
//!
//! Every process runs on the signed-in CLI with `ANTHROPIC_API_KEY`
//! withheld ([`AgentSpec::use_subscription`]); the dump goes nowhere but
//! the CLI.

use anyhow::{Context, Result, anyhow, bail};
use nightloom_core::{Session, SessionEvent, Usage};
use nightloom_service::council::{
    self, Anonymised, CouncilMode, CouncilRequest, Seat, SeatResult, chair_prompt,
    in_context_prompt, overlap, seat_spec, shuffle, sources_in,
};
use nightloom_service::{AgentOutcome, AgentSpec, ClaudeCodeAgent, TurnEvent, project, store};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(clap::Args)]
pub struct CouncilTrialArgs {
    /// A chat id (or unambiguous prefix) whose first message is the dump,
    /// or a path to a file holding the dump. Omit with --tally.
    #[arg(value_name = "CHAT-ID | DUMP-FILE")]
    input: Option<String>,

    /// Where the runs go: `<out>/<run-id>/`. Defaults to
    /// `~/.nightloom/council-trial` (NIGHTLOOM_HOME respected).
    #[arg(long)]
    out: Option<PathBuf>,

    /// The council's seats, comma-separated model aliases.
    #[arg(long, default_value = "opus,fable,opus")]
    seats: String,

    /// The single turn's model (arms i and iii).
    #[arg(long, default_value = "opus")]
    single: String,

    /// The chair's model (arm ii).
    #[arg(long, default_value = "opus")]
    chair: String,

    /// answer | disproof
    #[arg(long, default_value = "answer")]
    mode: String,

    /// The Claude Code binary.
    #[arg(long, default_value = "claude")]
    binary: String,

    /// `--effort` for every process (low | medium | high | xhigh | max).
    #[arg(long)]
    effort: Option<String>,

    /// Which arms to run, comma-separated: single,council,in_context.
    /// Fewer than three still writes a judgeable folder.
    #[arg(long, default_value = "single,council,in_context")]
    arms: String,

    /// Sum the judged runs under this folder instead of running one.
    #[arg(long, value_name = "DIR")]
    tally: Option<PathBuf>,
}

/// One arm as the record keeps it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ArmMetrics {
    arm: String,
    /// ~~The letter the answer was filed under.~~ Never written since
    /// 2026-09-18 (the review): `metrics.json` sits beside the answers and
    /// was carrying the arm-to-letter map in plain JSON, and the run-end
    /// table printed it to the terminal — the "sealed" key was sealed
    /// nowhere. The map lives in `key.sealed.json` alone; the tally reads
    /// it there. Kept as a field so an older `metrics.json` still parses.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    label: String,
    model: String,
    words: usize,
    /// Sources named in the answer (URLs and DOIs, normalised).
    sources: Vec<String>,
    usage: Usage,
    cost_usd: Option<f64>,
    wall_ms: u64,
    tool_uses: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// What the council arm records beyond an arm's own figures.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CouncilMetrics {
    seats: Vec<SeatMetrics>,
    overlap: council::Overlap,
    /// Sources the chair's synthesis cites that the single turn did not.
    chair_sources_not_in_single: Vec<String>,
    /// Lines under the chair's "found by one member only" heading.
    section3_lines: usize,
    chair_usage: Usage,
    chair_cost_usd: Option<f64>,
    chair_wall_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SeatMetrics {
    label: String,
    model: String,
    words: usize,
    searches: u32,
    tool_uses: u32,
    cited: Vec<String>,
    seen: usize,
    usage: Usage,
    cost_usd: Option<f64>,
    wall_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    angle: Option<(usize, usize)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Metrics {
    run_id: String,
    dump_from: String,
    dump_chars: usize,
    mode: CouncilMode,
    arms: Vec<ArmMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    council: Option<CouncilMetrics>,
}

pub async fn run(args: CouncilTrialArgs) -> Result<()> {
    if let Some(dir) = &args.tally {
        return tally(dir);
    }
    let input = args
        .input
        .as_deref()
        .ok_or_else(|| anyhow!("give a chat id or a dump file, or --tally <dir>"))?;
    let mode = match args.mode.as_str() {
        "answer" => CouncilMode::Answer,
        "disproof" => CouncilMode::Disproof,
        other => bail!("--mode {other}: answer or disproof"),
    };
    let seats: Vec<Seat> = args
        .seats
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(Seat::subscription)
        .collect();
    let request = CouncilRequest {
        seats,
        mode,
        areas: Vec::new(),
    };
    request.validate()?;
    let arms: BTreeSet<&str> = args.arms.split(',').map(str::trim).collect();

    let (dump, dump_from) = load_dump(input)?;
    let out_root = args.out.clone().unwrap_or_else(|| {
        project::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("council-trial")
    });
    let run_id = format!(
        "{}-{}",
        chrono::Local::now().format("%Y-%m-%dT%H-%M-%S"),
        short(&dump_from)
    );
    let dir = out_root.join(&run_id);
    fs::create_dir_all(dir.join("stream"))
        .with_context(|| format!("creating {}", dir.display()))?;
    fs::create_dir_all(dir.join("seats"))?;
    fs::write(dir.join("dump.md"), &dump)?;
    eprintln!(
        "council-trial: {} chars from {dump_from} → {}",
        dump.len(),
        dir.display()
    );

    // Every process is rooted in the run's own folder: no project, no
    // CLAUDE.md, no hooks, no memory (safe mode) — the same footing for
    // all three arms.
    let cwd = dir.join("cwd");
    fs::create_dir_all(&cwd)?;
    let mut base = AgentSpec::new(&cwd);
    base.binary = args.binary.clone();
    base.safe_mode = true;
    base.auto_memory = false;
    base.effort = args.effort.clone();
    let agent = ClaudeCodeAgent::new(base.clone());
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            trigger.cancel();
        }
    });

    let mut answers: Vec<(String, String)> = Vec::new(); // (arm, text)
    let mut arm_metrics: Vec<ArmMetrics> = Vec::new();
    let mut council_metrics: Option<CouncilMetrics> = None;
    let mut single_sources: BTreeSet<String> = BTreeSet::new();

    // (i) the single turn: the seat's position, the dump alone.
    if arms.contains("single") {
        eprintln!("arm i — single ({})…", args.single);
        let spec = seat_spec(&base, &Seat::subscription(&args.single));
        let (outcome, wall, tool_uses) = run_one(
            &agent,
            &spec,
            &dump,
            &cancel,
            &dir.join("stream/single.jsonl"),
        )
        .await;
        let text = text_of(&outcome);
        single_sources = sources_in(&text);
        arm_metrics.push(arm_row(
            "single",
            &args.single,
            &text,
            &outcome,
            wall,
            tool_uses,
        ));
        answers.push(("single".into(), text));
    }

    // (ii) the council: the seats, then the chair.
    if arms.contains("council") {
        eprintln!(
            "arm ii — council ({}), chair {}…",
            request
                .seats
                .iter()
                .map(|s| s.model.as_str())
                .collect::<Vec<_>>()
                .join(" + "),
            args.chair
        );
        let seed = now_nanos();
        let stream_dir = dir.join("stream");
        let mut files: Vec<fs::File> = (0..request.seats.len())
            .map(|i| fs::File::create(stream_dir.join(format!("seat-{}.jsonl", i + 1))))
            .collect::<std::io::Result<_>>()?;
        let started = Instant::now();
        // A line per seat when its state or its call count changes, not
        // on every token figure.
        let mut shown: Vec<(String, u32)> = vec![(String::new(), 0); request.seats.len()];
        let mut on_event = |seat: usize, e: TurnEvent| {
            if let TurnEvent::SubagentStatus {
                status,
                tool_uses,
                tokens,
                ..
            } = &e
            {
                if shown[seat].0 != *status || shown[seat].1 != *tool_uses {
                    shown[seat] = (status.clone(), *tool_uses);
                    eprintln!(
                        "  seat {} ({}): {status}, {tool_uses} calls, {} tokens, {}s",
                        seat + 1,
                        request.seats[seat].model,
                        tokens,
                        started.elapsed().as_secs()
                    );
                }
                return;
            }
            if let Ok(line) = serde_json::to_string(&e) {
                let _ = writeln!(files[seat], "{line}");
            }
        };
        let results = council::run_seats(
            &agent,
            &base,
            None,
            &request,
            &dump,
            seed,
            &cancel,
            &mut on_event,
        )
        .await;
        for r in &results {
            fs::write(
                dir.join("seats").join(format!(
                    "seat-{}-{}-{}.md",
                    r.index + 1,
                    r.label,
                    r.seat.model
                )),
                &r.text,
            )?;
            fs::write(
                dir.join("seats")
                    .join(format!("seat-{}-{}-sources.json", r.index + 1, r.label)),
                serde_json::to_string_pretty(&r.sources)?,
            )?;
        }
        let answered: Vec<&SeatResult> = results.iter().filter(|r| r.error.is_none()).collect();
        let cited: Vec<BTreeSet<String>> =
            answered.iter().map(|r| r.sources.cited.clone()).collect();
        let ov = overlap(&cited);
        eprintln!(
            "  overlap: shared by all {:.0}% of {} sources; pairs {}",
            ov.shared_by_all * 100.0,
            ov.union,
            ov.pairwise
                .iter()
                .map(|(i, j, x)| format!(
                    "{}∩{} {:.0}%",
                    results[*i].label,
                    results[*j].label,
                    x * 100.0
                ))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let (chair_text, chair_outcome, chair_wall, chair_tools) = if answered.is_empty() {
            eprintln!("  no seat answered; no chair");
            (String::new(), None, 0, 0)
        } else {
            let anon: Vec<Anonymised> = council::anonymised(&results);
            let prompt = chair_prompt(mode, &dump, &anon, &[]);
            fs::write(dir.join("seats").join("chair-prompt.md"), &prompt)?;
            eprintln!("  chair ({})…", args.chair);
            let spec = seat_spec(&base, &Seat::subscription(&args.chair));
            let (o, wall, tools) = run_one(
                &agent,
                &spec,
                &prompt,
                &cancel,
                &dir.join("stream/chair.jsonl"),
            )
            .await;
            (text_of(&o), Some(o), wall, tools)
        };
        let chair_sources = sources_in(&chair_text);
        let not_in_single: Vec<String> =
            chair_sources.difference(&single_sources).cloned().collect();
        let (chair_usage, chair_cost) = match &chair_outcome {
            Some(Ok(o)) => (o.usage, o.cost_usd),
            _ => (Usage::default(), None),
        };
        council_metrics = Some(CouncilMetrics {
            seats: results
                .iter()
                .map(|r| SeatMetrics {
                    label: r.label.clone(),
                    model: r.seat.model.clone(),
                    words: r.words(),
                    searches: r.searches,
                    tool_uses: r.tool_uses,
                    cited: r.sources.cited.iter().cloned().collect(),
                    seen: r.sources.seen.len(),
                    usage: r.usage,
                    cost_usd: r.cost_usd,
                    wall_ms: r.duration_ms,
                    angle: r.angle,
                    error: r.error.clone(),
                })
                .collect(),
            overlap: ov,
            chair_sources_not_in_single: not_in_single,
            section3_lines: section_lines(&chair_text, "3."),
            chair_usage,
            chair_cost_usd: chair_cost,
            chair_wall_ms: chair_wall,
        });
        // The council arm's own row sums the seats and the chair.
        let mut usage = chair_usage;
        let mut cost: Option<f64> = chair_cost;
        let mut tool_uses = chair_tools;
        for r in &results {
            usage.add(r.usage);
            if let Some(c) = r.cost_usd {
                cost = Some(cost.unwrap_or(0.0) + c);
            }
            tool_uses += r.tool_uses;
        }
        let wall = started.elapsed().as_millis() as u64;
        let error = match &chair_outcome {
            None => Some("no seat answered".into()),
            Some(Err(e)) => Some(e.to_string()),
            Some(Ok(o)) if o.is_error => Some(o.notices.join("; ")),
            _ => None,
        };
        arm_metrics.push(ArmMetrics {
            arm: "council".into(),
            label: String::new(),
            model: format!(
                "{} → chair {}",
                request
                    .seats
                    .iter()
                    .map(|s| s.model.as_str())
                    .collect::<Vec<_>>()
                    .join("+"),
                args.chair
            ),
            words: chair_text.split_whitespace().count(),
            sources: chair_sources.into_iter().collect(),
            usage,
            cost_usd: cost,
            wall_ms: wall,
            tool_uses,
            error,
        });
        answers.push(("council".into(), chair_text));
    }

    // (iii) the in-context control.
    if arms.contains("in_context") {
        eprintln!(
            "arm iii — in-context ({}, {} members)…",
            args.single,
            request.seats.len()
        );
        let spec = seat_spec(&base, &Seat::subscription(&args.single));
        let prompt = in_context_prompt(mode, &dump, request.seats.len());
        let (outcome, wall, tool_uses) = run_one(
            &agent,
            &spec,
            &prompt,
            &cancel,
            &dir.join("stream/in_context.jsonl"),
        )
        .await;
        let text = text_of(&outcome);
        arm_metrics.push(arm_row(
            "in_context",
            &args.single,
            &text,
            &outcome,
            wall,
            tool_uses,
        ));
        answers.push(("in_context".into(), text));
    }

    // The blind: the arms under shuffled letters, the map sealed.
    let perm = shuffle(answers.len(), now_nanos());
    let mut key = serde_json::Map::new();
    for (pos, &arm_index) in perm.iter().enumerate() {
        let label = council::label(pos);
        let (arm, text) = &answers[arm_index];
        fs::write(dir.join(format!("answer-{label}.md")), text)?;
        key.insert(label.clone(), serde_json::Value::String(arm.clone()));
    }
    fs::write(
        dir.join("key.sealed.json"),
        serde_json::to_string_pretty(&serde_json::Value::Object(key))?,
    )?;
    let letters: Vec<String> = (0..answers.len()).map(council::label).collect();
    fs::write(
        dir.join("judge.md"),
        format!(
            "# Judge — {run_id}\n\n\
             Read answer-{}.md blind, in any order. Do not open key.sealed.json until this file is filled.\n\n\
             One thing to know while judging (nightshift blocker 256): the single turn was sent the \
             message bare, as you would send it; the council's members were told to search and to \
             cite. An answer with a Sources table is not, by that alone, the better one.\n\n\
             pick: \n\
             why: \n\n\
             Optional — a claim you wanted that only one answer had (letter and the claim):\n\
             wanted: \n",
            letters.join(".md, answer-")
        ),
    )?;
    let metrics = Metrics {
        run_id: run_id.clone(),
        dump_from,
        dump_chars: dump.len(),
        mode,
        arms: arm_metrics,
        council: council_metrics,
    };
    fs::write(
        dir.join("metrics.json"),
        serde_json::to_string_pretty(&metrics)?,
    )?;
    eprintln!();
    print_metrics(&metrics, None);
    eprintln!(
        "\nwritten: {}\n  answer-{}.md · judge.md (fill `pick:` with a letter) · key.sealed.json (open after)",
        dir.display(),
        letters.join(".md, answer-")
    );
    Ok(())
}

fn now_nanos() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
}

fn short(s: &str) -> String {
    let stem = Path::new(s)
        .file_stem()
        .and_then(|x| x.to_str())
        .unwrap_or(s);
    stem.chars().take(8).collect()
}

/// The dump: a file's contents, or the first user message of the chat
/// whose id starts with `input`, looked for in every registered project's
/// session store and the ad-hoc store for this folder.
fn load_dump(input: &str) -> Result<(String, String)> {
    let p = Path::new(input);
    if p.is_file() {
        let text = fs::read_to_string(p).with_context(|| format!("reading {}", p.display()))?;
        return Ok((text, p.display().to_string()));
    }
    let registry = project::Registry::load();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut dirs: Vec<PathBuf> = registry
        .projects()
        .iter()
        .map(|p| p.session_dir())
        .collect();
    dirs.push(project::store_for(&cwd).join(project::SESSIONS_DIR));
    let mut found: Vec<PathBuf> = Vec::new();
    for d in dirs {
        if let Ok(path) = store::find_by_prefix(&d, input) {
            found.push(path);
        }
    }
    found.dedup();
    let path = match found.len() {
        0 => {
            bail!("no chat with id starting {input} in any project store, and no file at that path")
        }
        1 => found.remove(0),
        _ => bail!("more than one chat matches {input}: give more of the id"),
    };
    let session = Session::load(&path).with_context(|| format!("loading {}", path.display()))?;
    let first = session
        .events()
        .iter()
        .find_map(|e| match e {
            SessionEvent::UserMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .ok_or_else(|| anyhow!("{} has no user message", path.display()))?;
    Ok((first, session.id.clone()))
}

/// One cold process, its events to a stream file. Returns the outcome,
/// the wall-clock and the tool-call count.
async fn run_one(
    agent: &ClaudeCodeAgent,
    spec: &AgentSpec,
    prompt: &str,
    cancel: &CancellationToken,
    stream: &Path,
) -> (
    Result<AgentOutcome, nightloom_service::AgentError>,
    u64,
    u32,
) {
    let mut file = fs::File::create(stream).ok();
    let mut tool_uses = 0u32;
    let started = Instant::now();
    let mut sink = |e: TurnEvent| {
        if matches!(e, TurnEvent::ToolCall { .. }) {
            tool_uses += 1;
            eprint!(".");
        }
        if let Some(f) = &mut file
            && let Ok(line) = serde_json::to_string(&e)
        {
            let _ = writeln!(f, "{line}");
        }
    };
    let outcome = agent.run_with(spec, prompt, cancel, &mut sink).await;
    let wall = started.elapsed().as_millis() as u64;
    eprintln!(" {}s", wall / 1000);
    (outcome, wall, tool_uses)
}

fn text_of(outcome: &Result<AgentOutcome, nightloom_service::AgentError>) -> String {
    match outcome {
        Ok(o) => o.text.clone(),
        Err(e) => format!("(no answer: {e})"),
    }
}

fn arm_row(
    arm: &str,
    model: &str,
    text: &str,
    outcome: &Result<AgentOutcome, nightloom_service::AgentError>,
    wall_ms: u64,
    tool_uses: u32,
) -> ArmMetrics {
    let (usage, cost_usd, error) = match outcome {
        Ok(o) => (
            o.usage,
            o.cost_usd,
            o.is_error.then(|| o.notices.join("; ")),
        ),
        Err(e) => (Usage::default(), None, Some(e.to_string())),
    };
    ArmMetrics {
        arm: arm.into(),
        label: String::new(),
        model: model.into(),
        words: text.split_whitespace().count(),
        sources: sources_in(text).into_iter().collect(),
        usage,
        cost_usd,
        wall_ms,
        tool_uses,
        error,
    }
}

/// Non-empty lines under the heading whose text starts with `number`
/// (`"3."` for "## 3. Found by one member only"), up to the next heading.
fn section_lines(text: &str, number: &str) -> usize {
    let mut inside = false;
    let mut n = 0;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('#') {
            inside = t.trim_start_matches('#').trim().starts_with(number);
            continue;
        }
        if inside && !t.is_empty() {
            n += 1;
        }
    }
    n
}

/// The run's figures as lines. `key` is the arm-to-letter map from
/// `key.sealed.json`, given only once the run is judged: without it the
/// per-arm rows are withheld — an arm's name beside its word count, on
/// the terminal he judges from, is the blind broken (the review of
/// 2026-09-18). The council's own seat lines are not arms and stay.
fn metrics_lines(
    m: &Metrics,
    key: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Vec<String> {
    let mut out = vec![format!(
        "run {} — {} chars, mode {}",
        m.run_id,
        m.dump_chars,
        m.mode.label()
    )];
    match key {
        None => out.push(
            "per-arm rows (words, tokens, cost, calls) print with --tally once judge.md is filled — not before, so the letters stay blind"
                .to_string(),
        ),
        Some(key) => {
            out.push(format!(
                "{:<11} {:<3} {:<28} {:>6} {:>8} {:>7} {:>8} {:>8} {:>7} {:>5}",
                "arm", "as", "model", "words", "in", "out", "cache-r", "cost$", "secs", "calls"
            ));
            for a in &m.arms {
                let letter = key
                    .iter()
                    .find(|(_, v)| v.as_str() == Some(a.arm.as_str()))
                    .map(|(k, _)| k.as_str())
                    .unwrap_or("?");
                out.push(format!(
                    "{:<11} {:<3} {:<28} {:>6} {:>8} {:>7} {:>8} {:>8} {:>7} {:>5}{}",
                    a.arm,
                    letter,
                    a.model.chars().take(28).collect::<String>(),
                    a.words,
                    a.usage.input_tokens,
                    a.usage.output_tokens,
                    a.usage.cache_read_tokens.unwrap_or(0),
                    a.cost_usd
                        .map(|c| format!("{c:.2}"))
                        .unwrap_or_else(|| "-".into()),
                    a.wall_ms / 1000,
                    a.tool_uses,
                    a.error
                        .as_ref()
                        .map(|e| format!("  ERROR {e}"))
                        .unwrap_or_default()
                ));
            }
        }
    }
    if let Some(c) = &m.council {
        out.push(format!(
            "council: overlap shared-by-all {:.0}% of {} cited; section 3 has {} lines; chair cited {} source(s) the single turn did not",
            c.overlap.shared_by_all * 100.0,
            c.overlap.union,
            c.section3_lines,
            c.chair_sources_not_in_single.len()
        ));
        for s in &c.seats {
            out.push(format!(
                "  seat {} {:<8} {:>5} words {:>3} searches {:>3} cited {:>3} seen {:>8} in {:>6} out {:>5}s{}",
                s.label,
                s.model,
                s.words,
                s.searches,
                s.cited.len(),
                s.seen,
                s.usage.input_tokens,
                s.usage.output_tokens,
                s.wall_ms / 1000,
                s.error
                    .as_ref()
                    .map(|e| format!("  ERROR {e}"))
                    .unwrap_or_default()
            ));
        }
    }
    out
}

fn print_metrics(m: &Metrics, key: Option<&serde_json::Map<String, serde_json::Value>>) {
    for line in metrics_lines(m, key) {
        eprintln!("{line}");
    }
}

/// Sum the judged runs under `dir`: wins per arm, and the metric means.
fn tally(dir: &Path) -> Result<()> {
    // (run, picked arm, metrics, the key when the run is judged)
    type Judged = (
        String,
        Option<String>,
        Metrics,
        Option<serde_json::Map<String, serde_json::Value>>,
    );
    let mut runs: Vec<Judged> = Vec::new();
    for entry in fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let entry = entry?;
        let run = entry.path();
        let metrics_path = run.join("metrics.json");
        if !metrics_path.is_file() {
            continue;
        }
        let metrics: Metrics = serde_json::from_str(&fs::read_to_string(&metrics_path)?)
            .with_context(|| format!("parsing {}", metrics_path.display()))?;
        let key: serde_json::Value = fs::read_to_string(run.join("key.sealed.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Null);
        let pick = fs::read_to_string(run.join("judge.md"))
            .ok()
            .and_then(|j| pick_of(&j))
            .and_then(|letter| key.get(&letter).and_then(|v| v.as_str()).map(String::from));
        let judged_key = pick.as_ref().and_then(|_| key.as_object().cloned());
        runs.push((
            entry.file_name().to_string_lossy().into_owned(),
            pick,
            metrics,
            judged_key,
        ));
    }
    if runs.is_empty() {
        bail!(
            "no runs (folders with metrics.json) under {}",
            dir.display()
        );
    }
    runs.sort_by(|a, b| a.0.cmp(&b.0));
    let judged = runs.iter().filter(|r| r.1.is_some()).count();
    println!(
        "{} run(s) under {}, {judged} judged",
        runs.len(),
        dir.display()
    );
    for arm in ["single", "council", "in_context"] {
        let wins = runs.iter().filter(|r| r.1.as_deref() == Some(arm)).count();
        let rows: Vec<&ArmMetrics> = runs
            .iter()
            .filter_map(|r| r.2.arms.iter().find(|a| a.arm == arm))
            .collect();
        if rows.is_empty() {
            continue;
        }
        let n = rows.len() as f64;
        let mean = |f: &dyn Fn(&ArmMetrics) -> f64| rows.iter().map(|a| f(a)).sum::<f64>() / n;
        println!(
            "{arm:<11} wins {wins:>2}/{judged}   mean words {:>6.0}  in {:>8.0}  out {:>6.0}  cost ${:>5.2}  secs {:>5.0}  sources {:>4.1}",
            mean(&|a| a.words as f64),
            mean(&|a| a.usage.input_tokens as f64),
            mean(&|a| a.usage.output_tokens as f64),
            mean(&|a| a.cost_usd.unwrap_or(0.0)),
            mean(&|a| a.wall_ms as f64 / 1000.0),
            mean(&|a| a.sources.len() as f64),
        );
    }
    let councils: Vec<&CouncilMetrics> = runs.iter().filter_map(|r| r.2.council.as_ref()).collect();
    if !councils.is_empty() {
        let n = councils.len() as f64;
        println!(
            "council      mean overlap shared-by-all {:.0}%  section-3 lines {:.1}  chair sources not in single {:.1}  ({} run(s) fired the areas rule)",
            councils
                .iter()
                .map(|c| c.overlap.shared_by_all)
                .sum::<f64>()
                / n
                * 100.0,
            councils
                .iter()
                .map(|c| c.section3_lines as f64)
                .sum::<f64>()
                / n,
            councils
                .iter()
                .map(|c| c.chair_sources_not_in_single.len() as f64)
                .sum::<f64>()
                / n,
            councils.iter().filter(|c| c.overlap.fires()).count(),
        );
    }
    println!();
    for (run, pick, metrics, key) in &runs {
        println!("  {run}: {}", pick.as_deref().unwrap_or("(not judged)"));
        // The per-arm rows with their letters, for a judged run only —
        // the run itself printed none (the blind, 2026-09-18).
        if let Some(key) = key {
            for line in metrics_lines(metrics, Some(key)).into_iter().skip(1) {
                println!("    {line}");
            }
        }
    }
    println!(
        "\nThe design's reading (§6, blocker 245): the council earns its build at ≥ 7 of 10 picks *and* more picks than in_context; ≤ 3 of 10 stops it; between, run ten more."
    );
    Ok(())
}

/// The letter after `pick:` in a judge file, if any.
fn pick_of(judge: &str) -> Option<String> {
    judge.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("pick:")?.trim();
        let letter: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        (!letter.is_empty()).then(|| letter.to_ascii_uppercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pick_line_yields_a_letter_or_nothing() {
        assert_eq!(
            pick_of("# Judge\n\npick: b\nwhy: shorter\n").as_deref(),
            Some("B")
        );
        assert_eq!(pick_of("pick:   C — the sources\n").as_deref(), Some("C"));
        assert_eq!(pick_of("pick: \nwhy:\n"), None);
        assert_eq!(pick_of("no such line"), None);
    }

    #[test]
    fn section_lines_count_under_the_numbered_heading_only() {
        let t = "## 1. Agreed\n- a\n- b\n## 3. Found by one member only\n- x [B]\n\n- y [C]\n## 4. The chair's answer\n- z";
        assert_eq!(section_lines(t, "3."), 2);
        assert_eq!(section_lines(t, "1."), 2);
        assert_eq!(section_lines(t, "5."), 0);
    }

    /// The blind (the review of 2026-09-18): what a run prints and writes
    /// before he judges carries no arm-to-letter map — the arm rows are
    /// withheld from the terminal, and `metrics.json` serialises no
    /// `label` — while the tally, given the key, prints each arm under
    /// its letter.
    #[test]
    fn an_unjudged_run_prints_no_letters_and_metrics_json_holds_no_map() {
        let arm = |name: &str, words: usize| ArmMetrics {
            arm: name.into(),
            label: String::new(),
            model: "opus".into(),
            words,
            sources: vec![],
            usage: Usage::default(),
            cost_usd: None,
            wall_ms: 1000,
            tool_uses: 1,
            error: None,
        };
        let m = Metrics {
            run_id: "r1".into(),
            dump_from: "d".into(),
            dump_chars: 10,
            mode: CouncilMode::Answer,
            arms: vec![
                arm("single", 100),
                arm("council", 300),
                arm("in_context", 200),
            ],
            council: None,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("\"label\""), "{json}");
        let blind = metrics_lines(&m, None).join("\n");
        for word in ["single", "council", "in_context", " A ", " B ", " C "] {
            assert!(
                !blind.contains(&format!("{word:<11} ")),
                "{word} in {blind}"
            );
        }
        assert!(!blind.contains("300"), "{blind}");
        assert!(blind.contains("--tally"), "{blind}");
        let key: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"A":"council","B":"single","C":"in_context"}"#).unwrap();
        let shown = metrics_lines(&m, Some(&key)).join("\n");
        assert!(shown.contains("council     A  "), "{shown}");
        assert!(shown.contains("single      B  "), "{shown}");
        assert!(shown.contains("in_context  C  "), "{shown}");
        // An older metrics.json that still carries a label parses.
        let old: ArmMetrics = serde_json::from_str(
            r#"{"arm":"single","label":"B","model":"opus","words":1,"sources":[],"usage":{"input_tokens":0,"output_tokens":0},"cost_usd":null,"wall_ms":1,"tool_uses":0}"#,
        )
        .unwrap();
        assert_eq!(old.label, "B");
    }

    #[test]
    fn a_short_run_name_is_the_stem_cut_to_eight() {
        assert_eq!(short("/x/y/my-dump-file.md"), "my-dump-");
        assert_eq!(short("1fe6f49d-806a-4358"), "1fe6f49d");
    }
}
