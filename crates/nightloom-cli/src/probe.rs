use crate::{DIM, RESET};
use anyhow::{Context, Result, bail};
use nightloom_core::Thinking;
use nightloom_evals::{ProbeReport, ProbeSpec, run_probe};
use nightloom_providers::ProviderKind;
use nightloom_service::credentials;
use std::path::PathBuf;

/// Answer is 3901; the check catches a model that streams garbage that still
/// counts tokens. Reasoning models get something to actually reason about.
const DEFAULT_PROMPT: &str =
    "Compute 47 * 83. Reason it through carefully, then give the final answer as just the number.";
const DEFAULT_EXPECT: &str = "3901";

#[derive(clap::Args)]
pub struct ProbeArgs {
    /// Target as provider:model[:thinking][:tools], e.g. anthropic:claude-sonnet-5:effort=high
    /// or gemini:gemini-2.5-flash:tools. Repeatable. Defaults to a built-in matrix.
    #[arg(long = "target")]
    targets: Vec<String>,

    /// Run the tool round-trip check on every selected target
    #[arg(long)]
    tools: bool,

    /// Runs per target (TTFT is noisy; use 3+ for anything comparative)
    #[arg(long, default_value_t = 1)]
    runs: u32,

    /// Override the probe prompt (disables the answer check)
    #[arg(long)]
    prompt: Option<String>,

    #[arg(long, default_value_t = 8192)]
    max_tokens: u32,

    /// Base URL for openai/openai-chat targets (e.g. http://localhost:11434/v1)
    #[arg(long)]
    openai_base_url: Option<String>,

    /// Directory for JSON reports
    #[arg(long, default_value = ".nightloom/probes")]
    out_dir: PathBuf,

    /// Don't write a JSON report
    #[arg(long)]
    no_save: bool,
}

#[derive(Debug)]
struct Target {
    kind: ProviderKind,
    model: String,
    thinking: Thinking,
    tools: bool,
}

impl Target {
    fn new(kind: ProviderKind, model: &str, thinking: Thinking) -> Self {
        Self {
            kind,
            model: model.to_string(),
            thinking,
            tools: false,
        }
    }

    fn tools(mut self) -> Self {
        self.tools = true;
        self
    }

    fn label(&self) -> String {
        let mut label = match &self.thinking {
            Thinking::Default => format!("{}:{}", self.kind, self.model),
            t => format!("{}:{}:{t}", self.kind, self.model),
        };
        if self.tools {
            label.push_str(":tools");
        }
        label
    }
}

/// `provider:model[:thinking][:tools]`. A literal trailing `tools` segment
/// turns on the tool round-trip check; after that, only a trailing segment
/// that parses as a thinking spec is treated as one, so model IDs containing
/// ':' (ollama's `llama3:8b`) still work.
fn parse_target(s: &str) -> Result<Target> {
    let (provider, rest) = s.split_once(':').with_context(|| {
        format!("invalid target {s:?}: expected provider:model[:thinking][:tools]")
    })?;
    let kind: ProviderKind = provider
        .parse()
        .map_err(|e: String| anyhow::anyhow!("{e} in target {s:?}"))?;
    if rest == "tools" {
        bail!("missing model in target {s:?} (expected provider:model[:thinking][:tools])");
    }
    let (rest, tools) = match rest.strip_suffix(":tools") {
        Some(r) => (r, true),
        None => (rest, false),
    };
    let (model, thinking) = match rest.rsplit_once(':') {
        Some((m, tail)) => match tail.parse::<Thinking>() {
            Ok(t) => (m, t),
            Err(_) => (rest, Thinking::Default),
        },
        None => (rest, Thinking::Default),
    };
    if model.is_empty() {
        bail!("empty model in target {s:?} (expected provider:model[:thinking][:tools])");
    }
    let target = Target::new(kind, model, thinking);
    Ok(if tools { target.tools() } else { target })
}

fn default_targets() -> Vec<Target> {
    use ProviderKind::*;
    vec![
        // Adaptive-thinking frontier model, no explicit request; also carries
        // the tool round-trip for anthropic.
        Target::new(Anthropic, "claude-fable-5", Thinking::Default).tools(),
        // Claude 5: adaptive thinking + output_config.effort (budget is rejected).
        Target::new(
            Anthropic,
            "claude-sonnet-5",
            Thinking::Effort("high".into()),
        ),
        // Claude 4.5: classic budget-style thinking, streams real CoT.
        Target::new(
            Anthropic,
            "claude-haiku-4-5-20251001",
            Thinking::Budget(2048),
        ),
        // Responses API: reasoning summaries should STREAM as thinking, and
        // tool calls must survive the reasoning-item round trip.
        Target::new(Openai, "gpt-5-mini", Thinking::Effort("low".into())).tools(),
        // Non-reasoning control on the Responses API.
        Target::new(Openai, "gpt-4.1-mini", Thinking::Default),
        // Legacy chat/completions: reasoning billed but hidden.
        Target::new(OpenaiChat, "gpt-5-mini", Thinking::Effort("low".into())),
        // Gemini 2.5 thinks by default; thought summaries should stream.
        // Tool round trip exercises name-addressed function results.
        Target::new(Gemini, "gemini-2.5-flash", Thinking::Default).tools(),
        Target::new(Gemini, "gemini-2.5-pro", Thinking::Budget(1024)),
        // Groq: default-mode qwen + exposed-reasoning gpt-oss.
        Target::new(Groq, "qwen/qwen3.6-27b", Thinking::Default),
        Target::new(Groq, "openai/gpt-oss-120b", Thinking::Effort("low".into())).tools(),
        // OpenRouter gateway: plain model + reasoning model with effort.
        // No tool check here: routing may land on a model without tool support.
        Target::new(
            Openrouter,
            "meta-llama/llama-3.3-70b-instruct",
            Thinking::Default,
        ),
        Target::new(Openrouter, "x-ai/grok-4.3", Thinking::Effort("low".into())),
    ]
}

fn fmt_ms(v: Option<u64>) -> String {
    v.map(|m| format!("{m}")).unwrap_or_else(|| "-".into())
}

fn print_header() {
    println!(
        "{:<48} {:>6} {:>7} {:>7} {:>7} {:>12} {:>8} {:>18} {:>7} {:<14} status",
        "target",
        "ttft",
        "think",
        "text",
        "total",
        "think(ch/Δ)",
        "text ch",
        "tok in/out/rsn",
        "tools",
        "stop",
    );
    println!("{}", "-".repeat(150));
}

fn print_row(r: &ProbeReport) {
    let (in_t, out_t, rsn_t) = match r.usage {
        Some(u) => (
            u.input_tokens.to_string(),
            u.output_tokens.to_string(),
            u.reasoning_tokens
                .map(|n| n.to_string())
                .unwrap_or_else(|| "-".into()),
        ),
        None => ("-".into(), "-".into(), "-".into()),
    };
    let status = if r.error.as_deref().is_some_and(|e| e.starts_with("skipped")) {
        "SKIP"
    } else if r.ok {
        "ok"
    } else {
        "FAIL"
    };
    // Call count + round-trip verdict; "-" for rows without the tool check.
    let tools = match r.tool_round_ok {
        Some(ok) => format!("{}/{}", r.tool_calls, if ok { "ok" } else { "x" }),
        None => "-".into(),
    };
    println!(
        "{:<48} {:>6} {:>7} {:>7} {:>7} {:>12} {:>8} {:>18} {:>7} {:<14} {}",
        r.label,
        fmt_ms(r.ttft_ms()),
        fmt_ms(r.ttf_thinking_ms),
        fmt_ms(r.ttf_text_ms),
        r.total_ms,
        format!("{}/{}", r.thinking_chars, r.thinking_deltas),
        r.text_chars,
        format!("{in_t}/{out_t}/{rsn_t}"),
        tools,
        r.stop_reason.as_deref().unwrap_or("-"),
        status,
    );
    if let Some(e) = &r.error {
        println!("    {DIM}error: {e}{RESET}");
    }
    for d in &r.diagnostics {
        println!("    {DIM}{d}{RESET}");
    }
}

pub async fn run(args: ProbeArgs) -> Result<()> {
    let mut targets = if args.targets.is_empty() {
        default_targets()
    } else {
        args.targets
            .iter()
            .map(|s| parse_target(s))
            .collect::<Result<Vec<_>>>()?
    };
    if args.tools {
        for t in &mut targets {
            t.tools = true;
        }
    }

    println!(
        "probing {} target(s), {} run(s) each{}",
        targets.len(),
        args.runs,
        if args.prompt.is_some() {
            " (custom prompt, answer check off)"
        } else {
            ""
        }
    );
    print_header();

    let mut reports: Vec<ProbeReport> = Vec::new();
    for target in &targets {
        let spec = ProbeSpec {
            label: target.label(),
            model: target.model.clone(),
            thinking: target.thinking.clone(),
            // Tool rows ignore this: the probe substitutes its fixture prompt.
            prompt: args.prompt.clone().unwrap_or_else(|| DEFAULT_PROMPT.into()),
            max_tokens: args.max_tokens,
            // For tool rows the codeword round trip is the answer check.
            expect_substring: (args.prompt.is_none() && !target.tools)
                .then(|| DEFAULT_EXPECT.into()),
            // Anthropic effort maps to adaptive thinking: the model decides
            // whether to think at all, so absence isn't a pipeline failure.
            thinking_optional: target.kind == ProviderKind::Anthropic
                && matches!(target.thinking, Thinking::Effort(_)),
            tool_check: target.tools,
        };
        let base_url = match target.kind {
            ProviderKind::Openai | ProviderKind::OpenaiChat => args.openai_base_url.clone(),
            _ => None,
        };
        let provider = target
            .kind
            .build(credentials::provider_key(target.kind), base_url);
        for _ in 0..args.runs {
            let report = match &provider {
                Ok(p) => run_probe(p.as_ref(), &spec).await,
                Err(e) => ProbeReport::skipped(target.kind.label(), &spec, &e.to_string()),
            };
            print_row(&report);
            reports.push(report);
        }
    }

    let failed = reports
        .iter()
        .filter(|r| !r.ok)
        .filter(|r| !r.error.as_deref().is_some_and(|e| e.starts_with("skipped")))
        .count();
    let skipped = reports.len() - failed - reports.iter().filter(|r| r.ok).count();
    println!(
        "\n{} ok, {} failed, {} skipped",
        reports.iter().filter(|r| r.ok).count(),
        failed,
        skipped
    );

    if !args.no_save {
        std::fs::create_dir_all(&args.out_dir)?;
        let path = args.out_dir.join(format!(
            "probe-{}.json",
            chrono::Utc::now().format("%Y%m%d-%H%M%S")
        ));
        std::fs::write(&path, serde_json::to_string_pretty(&reports)?)?;
        println!("{DIM}report: {}{RESET}", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_target() {
        let t = parse_target("anthropic:claude-sonnet-5").unwrap();
        assert_eq!(t.kind, ProviderKind::Anthropic);
        assert_eq!(t.model, "claude-sonnet-5");
        assert_eq!(t.thinking, Thinking::Default);
        assert!(!t.tools);
    }

    #[test]
    fn parses_thinking_and_tools() {
        let t = parse_target("anthropic:claude-sonnet-5:effort=high:tools").unwrap();
        assert_eq!(t.model, "claude-sonnet-5");
        assert_eq!(t.thinking, Thinking::Effort("high".into()));
        assert!(t.tools);
        assert_eq!(t.label(), "anthropic:claude-sonnet-5:effort=high:tools");
    }

    #[test]
    fn parses_tools_without_thinking() {
        let t = parse_target("gemini:gemini-2.5-flash:tools").unwrap();
        assert_eq!(t.model, "gemini-2.5-flash");
        assert_eq!(t.thinking, Thinking::Default);
        assert!(t.tools);
    }

    #[test]
    fn colon_model_keeps_working_with_tools() {
        let t = parse_target("openai-chat:llama3:8b:tools").unwrap();
        assert_eq!(t.kind, ProviderKind::OpenaiChat);
        assert_eq!(t.model, "llama3:8b");
        assert!(t.tools);
    }

    #[test]
    fn bare_tools_is_not_a_model() {
        let err = parse_target("groq:tools").unwrap_err().to_string();
        assert!(err.contains("missing model"), "got: {err}");
        let err = parse_target("groq::tools").unwrap_err().to_string();
        assert!(err.contains("empty model"), "got: {err}");
    }

    #[test]
    fn bad_provider_stays_loud() {
        assert!(parse_target("frobnicator:model:tools").is_err());
    }
}
