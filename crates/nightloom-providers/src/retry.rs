use nightloom_core::{ChatRequest, EventStream, Provider, ProviderError};
use std::time::Duration;

/// Called before each retry sleep with the error and the attempt number
/// that just failed, so a UI can surface the stall.
pub type RetryNotify = Box<dyn Fn(&ProviderError, u32) + Send + Sync>;

/// Wraps any provider and retries *opening* the stream on transient
/// failures with exponential backoff. Only the request open is retried —
/// nothing has streamed yet, so a retry can't duplicate output. Mid-stream
/// errors are not retried: replaying a half-consumed stream would need
/// dedup the consumer is better placed to handle.
pub struct Retry {
    inner: Box<dyn Provider>,
    max_attempts: u32,
    base_delay: Duration,
    notify: Option<RetryNotify>,
}

impl Retry {
    pub fn new(inner: Box<dyn Provider>) -> Self {
        Self {
            inner,
            max_attempts: 4,
            base_delay: Duration::from_millis(500),
            notify: None,
        }
    }

    pub fn max_attempts(mut self, n: u32) -> Self {
        self.max_attempts = n.max(1);
        self
    }

    pub fn base_delay(mut self, d: Duration) -> Self {
        self.base_delay = d;
        self
    }

    pub fn on_retry(mut self, f: RetryNotify) -> Self {
        self.notify = Some(f);
        self
    }
}

/// Transport failures and status codes that signal a transient condition
/// (timeouts, rate limits, server errors, Anthropic's 529 overloaded).
fn retryable(e: &ProviderError) -> bool {
    match e {
        ProviderError::Transport(_) => true,
        ProviderError::Api { status, .. } => {
            matches!(status, 408 | 429 | 500 | 502 | 503 | 504 | 529)
        }
        _ => false,
    }
}

#[async_trait::async_trait]
impl Provider for Retry {
    fn name(&self) -> &'static str {
        self.inner.name()
    }

    async fn stream_chat(&self, request: ChatRequest) -> Result<EventStream, ProviderError> {
        let mut delay = self.base_delay;
        for attempt in 1..=self.max_attempts {
            match self.inner.stream_chat(request.clone()).await {
                Ok(stream) => return Ok(stream),
                Err(e) if attempt < self.max_attempts && retryable(&e) => {
                    if let Some(notify) = &self.notify {
                        notify(&e, attempt);
                    }
                    tokio::time::sleep(delay).await;
                    delay *= 2;
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!("loop returns on the final attempt")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::SystemPrompt;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Fails with the scripted error until `failures` calls have been made,
    /// then succeeds with an empty stream.
    struct Flaky {
        failures: u32,
        calls: AtomicU32,
        error: fn() -> ProviderError,
    }

    #[async_trait::async_trait]
    impl Provider for Flaky {
        fn name(&self) -> &'static str {
            "flaky"
        }

        async fn stream_chat(&self, _: ChatRequest) -> Result<EventStream, ProviderError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) < self.failures {
                Err((self.error)())
            } else {
                Ok(Box::pin(futures::stream::empty()))
            }
        }
    }

    fn request() -> ChatRequest {
        ChatRequest {
            model: "m".into(),
            system: SystemPrompt::default(),
            messages: vec![],
            max_tokens: 16,
            temperature: None,
            thinking: nightloom_core::Thinking::Default,
            tools: vec![],
        }
    }

    fn retry(failures: u32, error: fn() -> ProviderError) -> Retry {
        Retry::new(Box::new(Flaky {
            failures,
            calls: AtomicU32::new(0),
            error,
        }))
        .base_delay(Duration::from_millis(1))
    }

    #[tokio::test]
    async fn retries_transient_errors_until_success() {
        let p = retry(3, || ProviderError::Transport("reset".into()));
        assert!(p.stream_chat(request()).await.is_ok());
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let p = retry(4, || ProviderError::Api {
            status: 529,
            message: "overloaded".into(),
        });
        match p.stream_chat(request()).await {
            Err(ProviderError::Api { status: 529, .. }) => {}
            _ => panic!("expected the 529 to surface after retries ran out"),
        }
    }

    #[tokio::test]
    async fn non_retryable_errors_fail_immediately() {
        let p = retry(1, || ProviderError::Api {
            status: 401,
            message: "bad key".into(),
        });
        assert!(p.stream_chat(request()).await.is_err());
        // A second call would succeed; immediate failure proves no retry ran.
    }

    #[tokio::test]
    async fn notify_fires_once_per_retry() {
        static FIRED: AtomicU32 = AtomicU32::new(0);
        let p = retry(2, || ProviderError::Transport("reset".into())).on_retry(Box::new(|_, _| {
            FIRED.fetch_add(1, Ordering::SeqCst);
        }));
        let _stream = p.stream_chat(request()).await.unwrap();
        assert_eq!(FIRED.load(Ordering::SeqCst), 2);
    }
}
