//! `nightloom mcp-serve` ends on SIGTERM and SIGINT while its stdin is
//! still open (night review 2026-09-23, finding 2). Before the fix it
//! dropped its tools and then hung until stdin closed: the runtime waited
//! for the blocking thread parked in the read of stdin, and the signal
//! handlers kept a second signal from killing it.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#;

/// Generous bounds: the fixed server exits in milliseconds, the broken one
/// never does, so nothing here depends on how busy the machine is.
const READY_WITHIN: Duration = Duration::from_secs(30);
const EXIT_WITHIN: Duration = Duration::from_secs(10);

fn ends_on(signal: &str) {
    let home = std::env::temp_dir().join(format!(
        "nightloom-mcp-serve-signal-{signal}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_nightloom"))
        .arg("mcp-serve")
        .env("NIGHTLOOM_HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // Kept open for the whole test: the hang only happens with stdin open.
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{INITIALIZE}").unwrap();
    stdin.flush().unwrap();

    // An answer to `initialize` means the server is serving, so its signal
    // handlers are installed — a signal before them would kill it by the
    // default disposition and prove nothing.
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx.recv_timeout(READY_WITHIN).unwrap_or_default();
    if !line.contains("\"id\":1") {
        let _ = child.kill();
        let _ = child.wait();
        panic!("no answer to initialize: {line:?}");
    }

    let killed = Command::new("kill")
        .args([format!("-{signal}"), child.id().to_string()])
        .status()
        .unwrap();
    assert!(killed.success());
    let asked = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if asked.elapsed() > EXIT_WITHIN {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    drop(stdin);
    let _ = std::fs::remove_dir_all(&home);
    let status = status.unwrap_or_else(|| {
        panic!("still running {EXIT_WITHIN:?} after SIG{signal} with stdin open")
    });
    // Ended by its own exit after dropping the tools, not by the signal.
    assert_eq!(status.code(), Some(0), "{status:?}");
}

#[test]
fn a_sigterm_ends_the_server_with_stdin_still_open() {
    ends_on("TERM");
}

#[test]
fn a_sigint_ends_the_server_with_stdin_still_open() {
    ends_on("INT");
}
