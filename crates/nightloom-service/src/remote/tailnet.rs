//! Where the listener may bind: the Mac's Tailscale address, and nothing
//! else.
//!
//! The rule (nightshift blocker 105, its default taken): the phone page is
//! served on the tailnet interface only — never `0.0.0.0`, never a LAN
//! address, and there is no option to. Tailscale's addresses all fall in
//! the carrier-grade NAT block `100.64.0.0/10`, which is why [`is_tailnet`]
//! can be a range check rather than a question to the daemon: an address
//! outside it is not a tailnet address whatever produced it, and the server
//! refuses to bind there (`Server::start`).
//!
//! Finding the address asks the CLI first and reads the interfaces second.
//! The CLI is authoritative but lives inside the app bundle on macOS
//! (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`, measured on his
//! Mac 2026-09-16) and may be elsewhere or absent; `ifconfig` is always
//! there and lists the `utun` interface Tailscale brought up, with the same
//! address (measured: `utun6`, `inet 100.121.88.105 --> 100.121.88.105`).

use std::net::{IpAddr, Ipv4Addr};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long the CLI may take to answer `ip -4` before it is killed and the
/// interfaces are read instead (review 2026-09-17 FA7: a daemon that
/// accepts the socket and never answers held the runtime worker asking).
pub const CLI_TIMEOUT: Duration = Duration::from_secs(2);

/// Where the Tailscale CLI lives on macOS when installed from the App Store
/// or the standalone package: inside the app bundle, not on `PATH`.
pub const MAC_APP_CLI: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/// Whether `ip` is in Tailscale's range, `100.64.0.0/10`.
pub fn is_tailnet(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_tailnet_v4(v4),
        IpAddr::V6(_) => false,
    }
}

fn is_tailnet_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

/// The Mac's tailnet IPv4 address, or `None` when Tailscale is not up.
///
/// Best-effort in every step: a CLI that is missing, refuses to run, or
/// prints nothing usable falls through to the interfaces, and a machine
/// with no `100.64/10` address anywhere reads as "no tailnet" — which the
/// caller turns into the message naming Tailscale.
pub fn address() -> Option<Ipv4Addr> {
    for cli in [MAC_APP_CLI, "tailscale"] {
        if let Some(ip) = cli_address(cli) {
            return Some(ip);
        }
    }
    interface_address()
}

/// `tailscale ip -4`: one address per line, the first is the node's own.
/// Waited for at most `CLI_TIMEOUT`; a CLI that hangs is killed and reads
/// as no answer.
fn cli_address(cli: &str) -> Option<Ipv4Addr> {
    let mut child = Command::new(cli)
        .args(["ip", "-4"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < CLI_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    // The child has exited; its one line of output is in the pipe.
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_cli_output(&String::from_utf8_lossy(&out.stdout))
}

/// The first tailnet address in `tailscale ip -4`'s output.
pub fn parse_cli_output(stdout: &str) -> Option<Ipv4Addr> {
    stdout
        .lines()
        .filter_map(|l| l.trim().parse::<Ipv4Addr>().ok())
        .find(|ip| is_tailnet_v4(*ip))
}

/// The first tailnet address any interface carries, from `ifconfig`.
fn interface_address() -> Option<Ipv4Addr> {
    let out = Command::new("ifconfig").output().ok()?;
    parse_ifconfig(&String::from_utf8_lossy(&out.stdout))
}

/// The first `inet 100.x.y.z` line of an `ifconfig` listing. The interface
/// name is not checked: Tailscale's is `utun<N>` on macOS and `tailscale0`
/// on Linux, and the range is the better test of both.
pub fn parse_ifconfig(stdout: &str) -> Option<Ipv4Addr> {
    stdout
        .lines()
        .filter_map(|l| {
            let mut words = l.split_whitespace();
            match (words.next(), words.next()) {
                (Some("inet"), Some(addr)) => addr.parse::<Ipv4Addr>().ok(),
                _ => None,
            }
        })
        .find(|ip| is_tailnet_v4(*ip))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cgnat_block_is_the_tailnet_and_nothing_else_is() {
        assert!(is_tailnet("100.64.0.1".parse().unwrap()));
        assert!(is_tailnet("100.121.88.105".parse().unwrap()));
        assert!(is_tailnet("100.127.255.254".parse().unwrap()));
        assert!(!is_tailnet("100.128.0.1".parse().unwrap()));
        assert!(!is_tailnet("100.63.255.255".parse().unwrap()));
        assert!(!is_tailnet("127.0.0.1".parse().unwrap()));
        assert!(!is_tailnet("0.0.0.0".parse().unwrap()));
        assert!(!is_tailnet("192.168.1.20".parse().unwrap()));
        assert!(!is_tailnet("::1".parse().unwrap()));
    }

    #[test]
    fn the_cli_output_is_one_address_per_line() {
        assert_eq!(
            parse_cli_output("100.121.88.105\n"),
            Some("100.121.88.105".parse().unwrap())
        );
        assert_eq!(parse_cli_output(""), None);
        assert_eq!(parse_cli_output("Tailscale is stopped.\n"), None);
        // A LAN address from a confused CLI is not accepted either.
        assert_eq!(parse_cli_output("192.168.1.5\n"), None);
    }

    #[test]
    fn ifconfig_yields_the_utun_address_and_skips_the_lan() {
        let listing = "\
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet6 fe80::14fa:a3a9:62c3:20fc%utun6 prefixlen 64 scopeid 0x15
\tinet 100.121.88.105 --> 100.121.88.105 netmask 0xffffffff
";
        assert_eq!(
            parse_ifconfig(listing),
            Some("100.121.88.105".parse().unwrap())
        );
        assert_eq!(parse_ifconfig("lo0:\n\tinet 127.0.0.1\n"), None);
    }
}
