use futures::StreamExt;
use nightloom_core::{ChatRequest, Message, Provider, StreamEvent, Thinking, Usage};
use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct ProbeSpec {
    pub label: String,
    pub model: String,
    pub thinking: Thinking,
    pub prompt: String,
    pub max_tokens: u32,
    /// If set, the final text must contain this substring to count as ok.
    pub expect_substring: Option<String>,
    /// True when the thinking request is advisory (adaptive-style): the model
    /// may legitimately decline to reason, so absence is a note, not a failure.
    pub thinking_optional: bool,
}

/// Everything observed during one probe run. Timings are measured from just
/// before the request is sent, so TTFT includes connection + queue time —
/// which is what a user actually experiences.
#[derive(Debug, Clone, Serialize)]
pub struct ProbeReport {
    pub label: String,
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub ok: bool,
    pub error: Option<String>,
    /// First stream event of any kind (e.g. message_start).
    pub ttf_event_ms: Option<u64>,
    pub ttf_thinking_ms: Option<u64>,
    pub ttf_text_ms: Option<u64>,
    pub total_ms: u64,
    pub thinking_deltas: u64,
    pub thinking_chars: u64,
    pub text_deltas: u64,
    pub text_chars: u64,
    pub usage: Option<Usage>,
    pub stop_reason: Option<String>,
    pub saw_end: bool,
    pub answer_ok: Option<bool>,
    /// Human-readable findings. Entries prefixed "note:" are informational
    /// and don't fail the probe; everything else does.
    pub diagnostics: Vec<String>,
}

impl ProbeReport {
    fn new(provider: &str, spec: &ProbeSpec) -> Self {
        Self {
            label: spec.label.clone(),
            provider: provider.to_string(),
            model: spec.model.clone(),
            thinking: spec.thinking.to_string(),
            ok: false,
            error: None,
            ttf_event_ms: None,
            ttf_thinking_ms: None,
            ttf_text_ms: None,
            total_ms: 0,
            thinking_deltas: 0,
            thinking_chars: 0,
            text_deltas: 0,
            text_chars: 0,
            usage: None,
            stop_reason: None,
            saw_end: false,
            answer_ok: None,
            diagnostics: Vec::new(),
        }
    }

    /// TTFT in the usual sense: first visible content delta of either kind.
    pub fn ttft_ms(&self) -> Option<u64> {
        match (self.ttf_thinking_ms, self.ttf_text_ms) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    pub fn skipped(provider: &str, spec: &ProbeSpec, reason: &str) -> Self {
        let mut r = Self::new(provider, spec);
        r.error = Some(format!("skipped: {reason}"));
        r
    }
}

pub async fn run_probe(provider: &dyn Provider, spec: &ProbeSpec) -> ProbeReport {
    let mut report = ProbeReport::new(provider.name(), spec);
    let request = ChatRequest {
        model: spec.model.clone(),
        system: None,
        messages: vec![Message::user(spec.prompt.clone())],
        max_tokens: spec.max_tokens,
        temperature: None,
        thinking: spec.thinking.clone(),
    };

    let start = Instant::now();
    let elapsed = |s: Instant| s.elapsed().as_millis() as u64;
    let mut text = String::new();

    match provider.stream_chat(request).await {
        Err(e) => report.error = Some(e.to_string()),
        Ok(mut stream) => {
            while let Some(event) = stream.next().await {
                if report.ttf_event_ms.is_none() {
                    report.ttf_event_ms = Some(elapsed(start));
                }
                match event {
                    Err(e) => {
                        report.error = Some(format!("mid-stream: {e}"));
                        break;
                    }
                    Ok(StreamEvent::ThinkingDelta(d)) => {
                        report.ttf_thinking_ms.get_or_insert_with(|| elapsed(start));
                        report.thinking_deltas += 1;
                        report.thinking_chars += d.chars().count() as u64;
                    }
                    Ok(StreamEvent::TextDelta(d)) => {
                        report.ttf_text_ms.get_or_insert_with(|| elapsed(start));
                        report.text_deltas += 1;
                        report.text_chars += d.chars().count() as u64;
                        text.push_str(&d);
                    }
                    Ok(StreamEvent::Usage(u)) => report.usage = Some(u),
                    Ok(StreamEvent::End { stop_reason }) => {
                        report.stop_reason = stop_reason;
                        report.saw_end = true;
                    }
                    Ok(_) => {}
                }
            }
        }
    }
    report.total_ms = elapsed(start);

    if let Some(expect) = &spec.expect_substring {
        report.answer_ok = Some(text.contains(expect.as_str()));
    }
    diagnose(&mut report, spec);
    report
}

fn diagnose(report: &mut ProbeReport, spec: &ProbeSpec) {
    let mut d = Vec::new();
    let thinking_requested = !matches!(spec.thinking, Thinking::Default);
    let reasoning_billed = report
        .usage
        .and_then(|u| u.reasoning_tokens)
        .unwrap_or(0);

    if report.error.is_none() {
        if !report.saw_end {
            d.push("stream ended without End event (connection dropped or adapter bug)".into());
        }
        if report.text_chars == 0 {
            d.push("no text output received".into());
        }
        match report.usage {
            None => d.push("no usage reported by provider".into()),
            Some(u) => {
                if u.input_tokens == 0 {
                    d.push("usage reported zero input tokens".into());
                }
                if u.output_tokens == 0 && report.text_chars > 0 {
                    d.push("text received but usage reports zero output tokens".into());
                }
            }
        }
        if report.stop_reason.is_none() && report.saw_end {
            d.push("no stop_reason reported".into());
        }
        if thinking_requested && report.thinking_deltas == 0 && reasoning_billed == 0 {
            if spec.thinking_optional {
                d.push(
                    "note: adaptive reasoning requested but model chose not to think \
                     (prompt may be too easy)"
                        .into(),
                );
            } else {
                d.push(
                    "reasoning requested but no thinking deltas or reasoning tokens observed"
                        .into(),
                );
            }
        }
        if report.answer_ok == Some(false) {
            d.push(format!(
                "answer check failed: expected {:?} in output",
                spec.expect_substring.as_deref().unwrap_or_default()
            ));
        }
        if reasoning_billed > 0 && report.thinking_deltas == 0 {
            d.push(format!(
                "note: {reasoning_billed} reasoning tokens billed but not streamed (provider hides CoT)"
            ));
        }
        if !thinking_requested && report.thinking_deltas > 0 {
            d.push("note: model produced thinking without it being requested (adaptive)".into());
        }
    }

    report.ok = report.error.is_none() && d.iter().all(|m| m.starts_with("note:"));
    report.diagnostics = d;
}
