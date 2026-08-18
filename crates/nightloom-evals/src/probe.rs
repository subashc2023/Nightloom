use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, Message, Provider, Role, StreamEvent, SystemPrompt, Thinking,
    ToolDef, Usage,
};
use serde::Serialize;
use std::time::Instant;

/// Fixture tool for the round-trip check. It is never executed — the probe
/// fabricates the result — so the check isolates the wire format: does the
/// adapter deliver tool definitions, surface ToolUse events, and accept
/// ToolResult blocks back.
const TOOL_NAME: &str = "lookup_codeword";
const TOOL_KEY: &str = "alpha";
const CODEWORD: &str = "MOONBEAM-7";
const TOOL_PROMPT: &str = "Use the lookup_codeword tool with key 'alpha', \
     then reply with exactly the codeword it returns.";

fn fixture_tool() -> ToolDef {
    ToolDef {
        name: TOOL_NAME.into(),
        description: "Look up the secret codeword for a given key".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": { "key": { "type": "string" } },
            "required": ["key"],
        }),
    }
}

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
    /// Run the two-leg tool round-trip: offer the fixture tool, require the
    /// model to call it, feed back a fabricated result, and require the final
    /// text to echo the codeword. Overrides `prompt` (tool, prompt, and
    /// fabricated result are one fixture); the codeword check plays the role
    /// of `expect_substring`, so leave that None for tool rows.
    pub tool_check: bool,
}

/// Everything observed during one probe run. Timings are measured from just
/// before the request is sent, so TTFT includes connection + queue time —
/// which is what a user actually experiences. For tool rows both legs share
/// one clock: `total_ms` spans the whole round trip, ttf_* record the first
/// occurrence across legs, and usage/delta counters are summed over legs.
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
    /// ToolUse events observed in leg 1 (0 when tool_check is off).
    pub tool_calls: u64,
    /// Whether the tool round-trip completed and the final text contained
    /// the codeword. None when tool_check is off.
    pub tool_round_ok: Option<bool>,
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
            tool_calls: 0,
            tool_round_ok: None,
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

/// Per-leg facts that don't accumulate across legs. Counters, ttf_*, and
/// usage fold straight into the report inside `stream_leg`.
struct Leg {
    text: String,
    /// Assistant content in stream order (thinking, text, tool calls),
    /// ready to replay verbatim in a follow-up request.
    blocks: Vec<ContentBlock>,
    saw_end: bool,
    stop_reason: Option<String>,
}

/// Flush accumulated thinking text into a block. Called with a signature at
/// a signed-block boundary; called without one when any other block (or the
/// stream end) interrupts pending thinking.
fn flush_thinking(pending: &mut String, blocks: &mut Vec<ContentBlock>, signature: Option<String>) {
    if !pending.is_empty() || signature.is_some() {
        blocks.push(ContentBlock::Thinking {
            text: std::mem::take(pending),
            signature,
        });
    }
}

async fn stream_leg(
    provider: &dyn Provider,
    request: ChatRequest,
    start: Instant,
    report: &mut ProbeReport,
) -> Leg {
    let elapsed = |s: Instant| s.elapsed().as_millis() as u64;
    let mut leg = Leg {
        text: String::new(),
        blocks: Vec::new(),
        saw_end: false,
        stop_reason: None,
    };
    // Providers that stream cumulative usage overwrite within the leg; the
    // leg's final figure is then added to the running total.
    let mut leg_usage: Option<Usage> = None;
    let mut pending_thinking = String::new();

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
                        pending_thinking.push_str(&d);
                    }
                    Ok(StreamEvent::ThinkingSignature(sig)) => {
                        flush_thinking(&mut pending_thinking, &mut leg.blocks, Some(sig));
                    }
                    Ok(StreamEvent::RedactedThinking { data }) => {
                        flush_thinking(&mut pending_thinking, &mut leg.blocks, None);
                        leg.blocks.push(ContentBlock::RedactedThinking { data });
                    }
                    Ok(StreamEvent::TextDelta(d)) => {
                        report.ttf_text_ms.get_or_insert_with(|| elapsed(start));
                        report.text_deltas += 1;
                        report.text_chars += d.chars().count() as u64;
                        leg.text.push_str(&d);
                        flush_thinking(&mut pending_thinking, &mut leg.blocks, None);
                        match leg.blocks.last_mut() {
                            Some(ContentBlock::Text { text }) => text.push_str(&d),
                            _ if !d.is_empty() => leg.blocks.push(ContentBlock::Text { text: d }),
                            _ => {}
                        }
                    }
                    Ok(StreamEvent::ToolUse { id, name, input }) => {
                        flush_thinking(&mut pending_thinking, &mut leg.blocks, None);
                        leg.blocks.push(ContentBlock::ToolUse { id, name, input });
                    }
                    Ok(StreamEvent::Usage(u)) => leg_usage = Some(u),
                    Ok(StreamEvent::End { stop_reason }) => {
                        leg.stop_reason = stop_reason;
                        leg.saw_end = true;
                    }
                    Ok(_) => {}
                }
            }
        }
    }
    flush_thinking(&mut pending_thinking, &mut leg.blocks, None);
    if let Some(u) = leg_usage {
        report.usage.get_or_insert_default().add(u);
    }
    leg
}

pub async fn run_probe(provider: &dyn Provider, spec: &ProbeSpec) -> ProbeReport {
    let mut report = ProbeReport::new(provider.name(), spec);
    let tools = if spec.tool_check {
        vec![fixture_tool()]
    } else {
        Vec::new()
    };
    let prompt = if spec.tool_check {
        TOOL_PROMPT.to_string()
    } else {
        spec.prompt.clone()
    };
    let user = Message::user(prompt);
    let request = ChatRequest {
        model: spec.model.clone(),
        // Deliberately bare: the probe measures raw streaming behavior, and a
        // preamble would distort TTFT and the token counts it reports.
        system: SystemPrompt::default(),
        messages: vec![user.clone()],
        max_tokens: spec.max_tokens,
        temperature: None,
        thinking: spec.thinking.clone(),
        tools: tools.clone(),
    };

    let start = Instant::now();
    let elapsed = |s: Instant| s.elapsed().as_millis() as u64;

    let leg1 = stream_leg(provider, request, start, &mut report).await;
    let mut final_text = leg1.text.clone();
    let mut saw_end = leg1.saw_end;
    let mut stop_reason = leg1.stop_reason.clone();

    if spec.tool_check {
        let tool_uses: Vec<_> = leg1
            .blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse { id, name, input } => Some((id, name, input)),
                _ => None,
            })
            .collect();
        report.tool_calls = tool_uses.len() as u64;
        let mut round_ok = false;
        if report.error.is_none() {
            for &(_, name, input) in &tool_uses {
                if name != TOOL_NAME {
                    report.diagnostics.push(format!(
                        "tool call to unexpected tool {name:?} (only {TOOL_NAME} was offered)"
                    ));
                }
                match input.get("key").and_then(|k| k.as_str()) {
                    None => report
                        .diagnostics
                        .push(format!("tool call input has no string \"key\": {input}")),
                    Some(k) if k != TOOL_KEY => report.diagnostics.push(format!(
                        "note: tool called with key {k:?}, prompt asked for {TOOL_KEY:?}"
                    )),
                    Some(_) => {}
                }
            }
            if tool_uses.is_empty() {
                // The model ignored an offered-and-prompted-for tool: hard
                // failure, whatever text it produced instead.
                report
                    .diagnostics
                    .push("tool offered and prompted for, but model made no tool calls".into());
            } else {
                // Leg 2: echo the assistant turn back verbatim in stream
                // order (thinking + text + tool_use blocks), answer every
                // call with the fabricated codeword, and let the model
                // finish with the same tools on offer.
                let assistant = leg1.blocks.clone();
                let signed = assistant
                    .iter()
                    .filter(|b| {
                        matches!(
                            b,
                            ContentBlock::Thinking {
                                signature: Some(_),
                                ..
                            }
                        )
                    })
                    .count();
                if signed > 0 {
                    report.diagnostics.push(format!(
                        "note: replayed {signed} signed thinking block(s) in leg 2"
                    ));
                }
                let results = tool_uses
                    .iter()
                    .map(|&(id, name, _)| ContentBlock::ToolResult {
                        tool_use_id: id.clone(),
                        name: name.clone(),
                        content: CODEWORD.into(),
                        is_error: false,
                    })
                    .collect();
                let request2 = ChatRequest {
                    model: spec.model.clone(),
                    system: SystemPrompt::default(),
                    messages: vec![
                        user,
                        Message::assistant(assistant),
                        Message {
                            role: Role::User,
                            content: results,
                        },
                    ],
                    max_tokens: spec.max_tokens,
                    temperature: None,
                    thinking: spec.thinking.clone(),
                    tools,
                };
                let leg2 = stream_leg(provider, request2, start, &mut report).await;
                final_text = leg2.text;
                saw_end = leg1.saw_end && leg2.saw_end;
                stop_reason = leg2.stop_reason;
                round_ok = report.error.is_none() && final_text.contains(CODEWORD);
                if report.error.is_none() && !round_ok {
                    report.diagnostics.push(format!(
                        "tool round-trip failed: final text does not contain {CODEWORD:?}"
                    ));
                }
            }
        }
        report.tool_round_ok = Some(round_ok);
    }

    report.saw_end = saw_end;
    report.stop_reason = stop_reason;
    report.total_ms = elapsed(start);

    if let Some(expect) = &spec.expect_substring {
        report.answer_ok = Some(final_text.contains(expect.as_str()));
    }
    diagnose(&mut report, spec);
    report
}

fn diagnose(report: &mut ProbeReport, spec: &ProbeSpec) {
    // Tool-check findings were pushed during the run; stream-health checks
    // append to them.
    let mut d = std::mem::take(&mut report.diagnostics);
    let thinking_requested = !matches!(spec.thinking, Thinking::Default);
    let reasoning_billed = report.usage.and_then(|u| u.reasoning_tokens).unwrap_or(0);

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

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;
    use futures::stream;
    use nightloom_core::{EventStream, ProviderError};
    use std::sync::Mutex;

    /// Plays back one scripted event list per expected request and records
    /// what was asked of it.
    struct Scripted {
        legs: Mutex<Vec<Vec<StreamEvent>>>,
        requests: Mutex<Vec<ChatRequest>>,
    }

    impl Scripted {
        fn new(legs: Vec<Vec<StreamEvent>>) -> Self {
            Self {
                legs: Mutex::new(legs),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl Provider for Scripted {
        fn name(&self) -> &'static str {
            "scripted"
        }

        async fn stream_chat(&self, request: ChatRequest) -> Result<EventStream, ProviderError> {
            self.requests.lock().unwrap().push(request);
            let mut legs = self.legs.lock().unwrap();
            assert!(!legs.is_empty(), "probe made more requests than scripted");
            let events = legs.remove(0);
            Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
        }
    }

    fn tool_spec() -> ProbeSpec {
        ProbeSpec {
            label: "t".into(),
            model: "m".into(),
            thinking: Thinking::Default,
            prompt: String::new(),
            max_tokens: 128,
            expect_substring: None,
            thinking_optional: false,
            tool_check: true,
        }
    }

    fn usage() -> StreamEvent {
        StreamEvent::Usage(Usage {
            input_tokens: 10,
            output_tokens: 5,
            reasoning_tokens: None,
        })
    }

    fn end(reason: &str) -> StreamEvent {
        StreamEvent::End {
            stop_reason: Some(reason.into()),
        }
    }

    #[test]
    fn tool_round_trip_happy_path() {
        let provider = Scripted::new(vec![
            vec![
                StreamEvent::ToolUse {
                    id: "call_1".into(),
                    name: TOOL_NAME.into(),
                    input: serde_json::json!({"key": "alpha"}),
                },
                usage(),
                end("tool_use"),
            ],
            vec![
                StreamEvent::TextDelta(format!("The codeword is {CODEWORD}.")),
                usage(),
                end("end_turn"),
            ],
        ]);
        let report = block_on(run_probe(&provider, &tool_spec()));

        assert!(report.ok, "diagnostics: {:?}", report.diagnostics);
        assert_eq!(report.tool_calls, 1);
        assert_eq!(report.tool_round_ok, Some(true));
        assert_eq!(report.stop_reason.as_deref(), Some("end_turn"));
        // Usage sums across legs.
        assert_eq!(report.usage.unwrap().input_tokens, 20);
        assert_eq!(report.usage.unwrap().output_tokens, 10);

        // Leg 2 carries the round trip: user, assistant tool_use, tool result.
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let leg2 = &requests[1];
        assert_eq!(leg2.messages.len(), 3);
        assert!(matches!(
            leg2.messages[1].content[0],
            ContentBlock::ToolUse { .. }
        ));
        match &leg2.messages[2].content[0] {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id, "call_1");
                assert_eq!(content, CODEWORD);
                assert!(!is_error);
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn signed_thinking_replays_in_leg2_in_stream_order() {
        let provider = Scripted::new(vec![
            vec![
                StreamEvent::ThinkingDelta("Need the ".into()),
                StreamEvent::ThinkingDelta("codeword tool.".into()),
                StreamEvent::ThinkingSignature("sig-1".into()),
                StreamEvent::TextDelta("Looking it up.".into()),
                StreamEvent::ToolUse {
                    id: "call_1".into(),
                    name: TOOL_NAME.into(),
                    input: serde_json::json!({"key": "alpha"}),
                },
                usage(),
                end("tool_use"),
            ],
            vec![
                StreamEvent::TextDelta(format!("The codeword is {CODEWORD}.")),
                usage(),
                end("end_turn"),
            ],
        ]);
        let report = block_on(run_probe(&provider, &tool_spec()));

        assert!(report.ok, "diagnostics: {:?}", report.diagnostics);
        assert_eq!(report.tool_round_ok, Some(true));
        assert!(
            report
                .diagnostics
                .iter()
                .any(|d| d == "note: replayed 1 signed thinking block(s) in leg 2"),
            "diagnostics: {:?}",
            report.diagnostics
        );

        // Leg 2's assistant turn replays the signed thinking block first,
        // then the text, then the tool call — in stream order.
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let assistant = &requests[1].messages[1];
        assert_eq!(assistant.content.len(), 3);
        match &assistant.content[0] {
            ContentBlock::Thinking { text, signature } => {
                assert_eq!(text, "Need the codeword tool.");
                assert_eq!(signature.as_deref(), Some("sig-1"));
            }
            other => panic!("expected Thinking, got {other:?}"),
        }
        assert!(matches!(
            &assistant.content[1],
            ContentBlock::Text { text } if text == "Looking it up."
        ));
        assert!(matches!(assistant.content[2], ContentBlock::ToolUse { .. }));
    }

    #[test]
    fn zero_tool_calls_is_hard_failure() {
        let provider = Scripted::new(vec![vec![
            StreamEvent::TextDelta("I don't need a tool for that.".into()),
            usage(),
            end("end_turn"),
        ]]);
        let report = block_on(run_probe(&provider, &tool_spec()));

        assert!(!report.ok);
        assert_eq!(report.tool_calls, 0);
        assert_eq!(report.tool_round_ok, Some(false));
        // No second leg without a call to answer.
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn missing_codeword_fails_round() {
        let provider = Scripted::new(vec![
            vec![
                StreamEvent::ToolUse {
                    id: "call_1".into(),
                    name: TOOL_NAME.into(),
                    input: serde_json::json!({"key": "alpha"}),
                },
                usage(),
                end("tool_use"),
            ],
            vec![
                StreamEvent::TextDelta("I could not find it.".into()),
                usage(),
                end("end_turn"),
            ],
        ]);
        let report = block_on(run_probe(&provider, &tool_spec()));

        assert!(!report.ok);
        assert_eq!(report.tool_round_ok, Some(false));
    }

    #[test]
    fn wrong_key_is_note_only() {
        let provider = Scripted::new(vec![
            vec![
                StreamEvent::ToolUse {
                    id: "call_1".into(),
                    name: TOOL_NAME.into(),
                    input: serde_json::json!({"key": "beta"}),
                },
                usage(),
                end("tool_use"),
            ],
            vec![
                StreamEvent::TextDelta(CODEWORD.into()),
                usage(),
                end("end_turn"),
            ],
        ]);
        let report = block_on(run_probe(&provider, &tool_spec()));

        assert!(report.ok, "diagnostics: {:?}", report.diagnostics);
        assert_eq!(report.tool_round_ok, Some(true));
        assert!(report.diagnostics.iter().any(|d| d.starts_with("note:")));
    }

    #[test]
    fn non_tool_row_leaves_round_none() {
        let provider = Scripted::new(vec![vec![
            StreamEvent::TextDelta("3901".into()),
            usage(),
            end("end_turn"),
        ]]);
        let spec = ProbeSpec {
            expect_substring: Some("3901".into()),
            tool_check: false,
            ..tool_spec()
        };
        let report = block_on(run_probe(&provider, &spec));

        assert!(report.ok, "diagnostics: {:?}", report.diagnostics);
        assert_eq!(report.tool_round_ok, None);
        assert_eq!(report.tool_calls, 0);
        assert_eq!(report.answer_ok, Some(true));
    }
}
