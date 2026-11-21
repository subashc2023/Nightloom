//! Print the morning scan's message (item 763) as Home would send it,
//! collected from this Mac's real Nightloom home — read only: the jobs
//! store is opened without its zone migration, nothing is saved.
//!
//! `cargo run -p nightloom-service --example home_scan_facts > msg.txt`

fn main() {
    let config = nightloom_service::project::config_dir().expect("a Nightloom home");
    let jobs = nightloom_service::jobs::Jobs::open_in(
        nightloom_service::jobs::Jobs::dir_under(&config),
        None,
    );
    let projects: Vec<(String, Option<std::path::PathBuf>)> =
        nightloom_service::project::Registry::load_in(&config)
            .projects()
            .into_iter()
            .map(|p| (p.name, p.workspace))
            .collect();
    let facts =
        nightloom_service::home::collect(&config, &jobs.list(), &projects, chrono::Utc::now());
    let accounts = !nightloom_service::home::reach::scan_accounts(&config).is_empty();
    print!(
        "{}",
        nightloom_service::home::scan_message(&facts, accounts)
    );
}
