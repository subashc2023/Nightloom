//! Manual smoke test for the web tools, which is the only way to exercise
//! them: their unit tests pin URL handling, extraction and response parsing
//! against canned input, and deliberately never touch the network, so what is
//! left to check is whether real pages come back readable.
//!
//! ```sh
//! cargo run -p nightloom-service --example web -- https://doc.rust-lang.org/std/
//! cargo run -p nightloom-service --example web -- --search "tokio select macro"
//! ```

use nightloom_core::tool::{CancellationToken, Tool};
use nightloom_service::tools::{Fetch, SearchBackend, env_search_key, web_tools};
use serde_json::json;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--search") => {
            let query = args[1..].join(" ");
            let Some(search) = web_tools(env_search_key).into_iter().nth(1) else {
                eprintln!(
                    "no search key set. One of: {}",
                    SearchBackend::ALL.map(|b| b.env_key()).join(", ")
                );
                return;
            };
            println!("{}\n", search.def().description);
            report(
                search
                    .call(json!({ "query": query }), &CancellationToken::new())
                    .await,
            );
        }
        Some(url) => {
            let offset = args.get(1).and_then(|o| o.parse::<u64>().ok()).unwrap_or(0);
            report(
                Fetch::new()
                    .call(
                        json!({ "url": url, "offset": offset }),
                        &CancellationToken::new(),
                    )
                    .await,
            );
        }
        None => eprintln!("usage: web <url> [offset] | web --search <query>"),
    }
}

fn report(result: Result<String, String>) {
    match result {
        Ok(text) => println!("{text}"),
        // What the model would receive as an `is_error` tool result: printed
        // the same way, because the wording is the thing being checked.
        Err(e) => println!("[error] {e}"),
    }
}
