//! `nightloom eval` — run the agentic task suite across a (provider, model)
//! matrix.
//!
//! The probe's sibling. Where `probe` asks whether a stream is healthy, this
//! asks whether a model can finish a job with these tools: it gets a
//! throwaway workspace, an instruction, and afterwards the disk is inspected.

use anyhow::{Context, Result, bail};
use nightloom_core::Thinking;
use nightloom_evals::suite::{self, SUITE};
use nightloom_evals::{TaskReport, run_task};
use nightloom_service::{Chat, PromptConfig, ProviderKind, prompt, tools};
use std::path::{Path, PathBuf};

const DIM: &str = "\x1b[2m";
const RESET: &str = "\x1b[0m";

#[derive(clap::Args)]
pub struct EvalArgs {
    /// Target as provider:model[:thinking], e.g. anthropic:claude-sonnet-5.
    /// Repeatable. Defaults to a small matrix of the providers with keys set.
    #[arg(long = "target")]
    targets: Vec<String>,

    /// Only run tasks whose name matches. Repeatable; defaults to all.
    #[arg(long = "task")]
    tasks: Vec<String>,

    /// Attempts per (target, task). These are sampled systems — a single run
    /// is a coin flip, not a measurement.
    #[arg(long, default_value_t = 3)]
    runs: usize,

    #[arg(long, default_value_t = 8192)]
    max_tokens: u32,

    /// Tool rounds a task may take. Deliberately generous: a run cut off by
    /// the cap measures the cap, not the model.
    #[arg(long, default_value_t = 24)]
    max_rounds: usize,

    /// Write the full report as JSON here
    #[arg(long, default_value = ".nightloom/evals")]
    out_dir: PathBuf,

    /// Print every failure's reason rather than just the counts
    #[arg(long)]
    verbose: bool,
}

struct Target {
    label: String,
    kind: ProviderKind,
    model: Option<String>,
    thinking: Thinking,
}

pub async fn run(args: EvalArgs) -> Result<()> {
    let targets = resolve_targets(&args)?;
    if targets.is_empty() {
        bail!("no targets: set a provider API key, or pass --target");
    }
    let tasks = resolve_tasks(&args)?;

    println!(
        "{DIM}{} target(s) x {} task(s) x {} run(s) = {} turns{RESET}",
        targets.len(),
        tasks.len(),
        args.runs,
        targets.len() * tasks.len() * args.runs
    );
    println!();

    let mut reports = Vec::new();
    for target in &targets {
        for task in &tasks {
            let report = run_task(task, &target.label, args.runs, |workspace| {
                build_chat(target, workspace, args.max_tokens, args.max_rounds)
            })
            .await;
            print_row(&report, args.verbose);
            reports.push(report);
        }
    }

    print_summary(&targets, &reports);
    write_report(&args.out_dir, &reports)?;
    Ok(())
}

/// One `Chat` per attempt, rooted at that attempt's throwaway workspace.
///
/// Tools on, approval **off**: an eval is unattended by definition, and a run
/// that parked on a consent prompt nobody is there to answer would measure
/// the timeout rather than the model. The workspace is a temp directory laid
/// out fresh for this attempt, so the file tools have nothing else to reach.
fn build_chat(
    target: &Target,
    workspace: &Path,
    max_tokens: u32,
    max_rounds: usize,
) -> Result<Chat, String> {
    let (provider, model) = nightloom_service::connect(
        target.kind,
        target.model.clone(),
        nightloom_service::credentials::provider_key(target.kind),
        None,
        None::<Box<dyn Fn(&nightloom_core::ProviderError, u32) + Send + Sync>>,
    )
    .map_err(|e| e.to_string())?;

    let mut chat = Chat::new(provider, model);
    chat.system = prompt::assemble(&PromptConfig {
        identity: true,
        environment: true,
        // Off: the eval's fixtures are the whole world for this run, and an
        // AGENTS.md discovered from the temp directory's ancestors would
        // silently change the instructions between machines. The walk runs to
        // the filesystem root, so that is not a hypothetical — one file in a
        // home directory would reach every eval workspace on that box.
        project_instructions: false,
        user_memory: false,
        // Same reason, one layer down: a docspace index is discovered state,
        // and an eval whose prompt depends on what a previous run left in the
        // workspace is not measuring the model.
        project: None,
        // And the vault is the same argument at its worst — it is not even
        // per-workspace, so the developer's own notes would reach every eval
        // on that machine and none on any other.
        knowledge: None,
        cwd: workspace.to_path_buf(),
        custom: None,
    });
    chat.thinking = target.thinking.clone();
    chat.max_tokens = max_tokens;
    chat.max_rounds = max_rounds;
    chat.context_limit = nightloom_service::context_limit(target.kind, &chat.model);
    chat.price = nightloom_service::price(target.kind, &chat.model);
    chat.tools = tools::builtin_in(workspace.to_path_buf());
    Ok(chat)
}

fn resolve_targets(args: &EvalArgs) -> Result<Vec<Target>> {
    if args.targets.is_empty() {
        return Ok(default_targets());
    }
    args.targets.iter().map(|s| parse_target(s)).collect()
}

fn parse_target(s: &str) -> Result<Target> {
    let (provider, rest) = s
        .split_once(':')
        .with_context(|| format!("invalid target {s:?}: expected provider:model[:thinking]"))?;
    let kind: ProviderKind = provider
        .parse()
        .map_err(|e: String| anyhow::anyhow!("{e} in target {s:?}"))?;
    let (model, thinking) = match rest.rsplit_once(':') {
        Some((m, tail)) => match tail.parse::<Thinking>() {
            Ok(t) => (m, t),
            Err(_) => (rest, Thinking::Default),
        },
        None => (rest, Thinking::Default),
    };
    Ok(Target {
        label: s.to_string(),
        kind,
        model: (!model.is_empty()).then(|| model.to_string()),
        thinking,
    })
}

/// One model per provider that has a key set.
///
/// Deliberately one apiece rather than a wide grid: the default should cost a
/// few cents and answer "does this work here", not audit a vendor's lineup.
fn default_targets() -> Vec<Target> {
    [
        ProviderKind::Anthropic,
        ProviderKind::Openai,
        ProviderKind::Gemini,
        ProviderKind::Groq,
    ]
    .into_iter()
    .filter(|k| k.has_credentials())
    .map(|kind| Target {
        label: kind.label().to_string(),
        kind,
        model: None,
        thinking: Thinking::Default,
    })
    .collect()
}

fn resolve_tasks(args: &EvalArgs) -> Result<Vec<&'static nightloom_evals::Task>> {
    if args.tasks.is_empty() {
        return Ok(SUITE.iter().collect());
    }
    args.tasks
        .iter()
        .map(|name| {
            suite::by_name(name).with_context(|| {
                let known: Vec<&str> = SUITE.iter().map(|t| t.name).collect();
                format!("no task named {name:?}; known: {}", known.join(", "))
            })
        })
        .collect()
}

fn print_row(report: &TaskReport, verbose: bool) {
    let passed = report.passed();
    let total = report.attempts.len();
    let mark = if passed == total {
        "ok"
    } else if passed == 0 {
        "FAIL"
    } else {
        "flaky"
    };
    let cost = match report.cost() {
        Some(c) => format!("${c:.4}"),
        None => "—".to_string(),
    };
    let rounds: f64 = report.attempts.iter().map(|a| a.rounds as f64).sum::<f64>() / total as f64;
    let median = report.median_ms();
    println!(
        "{:<26} {:<22} {passed}/{total} {mark:<6} {median:>6}ms  {rounds:>4.1} rounds  {cost}",
        report.target, report.task,
    );
    if verbose || passed < total {
        for (i, a) in report.attempts.iter().enumerate() {
            match &a.failure {
                // The shape tasks put the shape in their own message, where it
                // is the diagnosis rather than a statistic.
                Some(reason) => println!("{DIM}    run {}: {reason}{RESET}", i + 1),
                None if verbose => {
                    println!(
                        "{DIM}    run {}: ok — calls {}{RESET}",
                        i + 1,
                        a.trace.shape()
                    )
                }
                None => {}
            }
        }
    }
}

fn print_summary(targets: &[Target], reports: &[TaskReport]) {
    println!();
    for target in targets {
        let mine: Vec<&TaskReport> = reports
            .iter()
            .filter(|r| r.target == target.label)
            .collect();
        let passed: usize = mine.iter().map(|r| r.passed()).sum();
        let total: usize = mine.iter().map(|r| r.attempts.len()).sum();
        let costs: Vec<f64> = mine.iter().filter_map(|r| r.cost()).collect();
        let cost = if costs.is_empty() {
            "—".to_string()
        } else {
            format!("${:.4}", costs.iter().sum::<f64>())
        };
        println!(
            "{:<26} {passed}/{total} attempts passed   {cost}",
            target.label
        );
    }
}

fn write_report(dir: &Path, reports: &[TaskReport]) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!(
        "eval-{}.json",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    std::fs::write(&path, serde_json::to_string_pretty(reports)?)?;
    println!("{DIM}report: {}{RESET}", path.display());
    Ok(())
}
