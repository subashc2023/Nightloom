//! Manual smoke: `cargo run -p nightloom-providers --example list_models`
//! Hits every provider's models endpoint with env credentials.

use nightloom_providers::{ProviderKind, models::list_models};

#[tokio::main]
async fn main() {
    for kind in ProviderKind::ALL {
        if kind == ProviderKind::OpenaiChat {
            continue; // needs a base URL; covered by the openai row
        }
        match list_models(kind, None, None).await {
            Ok(ids) => {
                let head: Vec<_> = ids.iter().take(4).collect();
                println!("{kind}: {} models, e.g. {head:?}", ids.len());
            }
            Err(e) => println!("{kind}: ERROR {e}"),
        }
    }
}
