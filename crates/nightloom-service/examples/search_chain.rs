//! Manual smoke test for the search chain, which unit tests cannot reach:
//! what a vendor says when a key is wrong is a fact about that vendor, and
//! the whole design turns on telling that apart from a rate limit.
//!
//! Run it with a deliberately dead key ahead of a live one and watch the
//! first query retire the head and the second not pay for it:
//!
//! ```sh
//! TAVILY_API_KEY=tvly-not-a-real-key cargo run -p nightloom-service --example search_chain
//! ```
//!
//! Two real searches, so it spends whatever a search costs on the backend
//! that answers.

use nightloom_core::tool::CancellationToken;
use nightloom_service::credentials;
use nightloom_service::tools::{search_backends, web_tools};

#[tokio::main]
async fn main() {
    let chain = search_backends(credentials::search_key);
    if chain.is_empty() {
        eprintln!("no search key set — nothing to chain");
        return;
    }
    println!(
        "chain: {}\n",
        chain
            .iter()
            .map(|b| b.label())
            .collect::<Vec<_>>()
            .join(" -> ")
    );

    let search = web_tools(credentials::search_key)
        .into_iter()
        .find(|t| t.def().name == "web_search")
        .expect("a chain with a key offers web_search");
    println!("{}\n", search.def().description);

    let cancel = CancellationToken::new();
    for round in 1..=2 {
        let out = search
            .call(
                serde_json::json!({ "query": "rust async book", "max_results": 2 }),
                &cancel,
            )
            .await;
        match out {
            // The head of the output is where a failover reports itself.
            Ok(text) => println!(
                "--- query {round} ---\n{}\n",
                text.lines().take(4).collect::<Vec<_>>().join("\n")
            ),
            Err(e) => println!("--- query {round} failed ---\n{e}\n"),
        }
    }
}
