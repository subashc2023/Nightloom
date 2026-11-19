//! The Agent hook as a service-level binary (item 761's measured check):
//! `subagent_hook <chat dir>` behaves as `nightloom-desktop --subagent-hook
//! <chat dir>`, so a real CLI run can carry the hook without the desktop.
fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    nightloom_service::agent::brief::run_hook(&args)
}
