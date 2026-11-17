//! The usage ledger: what Claude Code has cost, read from files Nightloom
//! does not own.
//!
//! Since 2026-09-08 a user-global collector, `~/.claude/usage-ledger.py`, has
//! walked the Claude Code transcripts under `~/.claude/projects` every six
//! hours (a LaunchAgent, `com.swaraagsistla.claude-usage-ledger`) and folded
//! each day's API usage fields into a small CSV that outlives transcript
//! cleanup. It stores **tokens, never dollars**: cost is a view computed from
//! a rates table beside it, so a price change applies retroactively rather
//! than restating nothing or everything by accident. This module is the Rust
//! side of that view. It reads three files and writes none of them:
//!
//! ```text
//! ~/.claude/usage-ledger.csv     per-day token counts, keyed (date, model, scope)
//! ~/.claude/usage-rates.json     $/MTok per model and the two cache-write multipliers
//! ~/.claude/usage-surfaces.csv   7-day share of the weekly limit by surface, appended per snapshot
//! ```
//!
//! **Why not port the collector.** It depends on the desktop app's Chromium
//! cache layout and the `zstd` binary to read the surface split, and on the
//! transcript format for the rest — two undocumented formats that already
//! move. It runs on its own schedule and writes plain files; reading those is
//! the whole integration (nightshift blocker 060 took this call). The one
//! thing that has to agree to the cent is the cost formula, so it is
//! reproduced here exactly, in the same operation order, and a test pins the
//! Rust total for a real day to what the Python `report` prints for it.
//!
//! **Why this is not `Chat.price`.** [`nightloom_core::Session::cost`] sums
//! prices *recorded at the time of each exchange*, because a session's cost
//! is history and history does not change when a vendor changes a rate. The
//! ledger is the opposite stance on purpose: the collector's own docstring
//! says rates apply retroactively, so a number here restates when the table
//! does. Both are right for what they measure; neither should be fed the
//! other's figure. And every ledger dollar is an *API-equivalent* — the
//! transcripts it reads were mostly billed to a subscription, so the figure
//! is what the same turns would have cost on the API, the stance
//! `docs/service-agent.md` takes for the Claude Code engine's own estimate.
//!
//! The ledger's semantics, kept exactly (the collector is the spec):
//! - dates are **UTC** buckets, what Anthropic's dashboard uses;
//! - every count appears twice, `_raw` (one transcript line per content
//!   block, each repeating the message's usage — what the dashboard shows,
//!   ~2.3× high) and `_dedup` (one per API message id — what the API would
//!   bill). **Dedup is the billing basis** and the default everywhere here;
//! - `scope` is `main` or `subagent` (the transcript's `isSidechain`);
//! - a fast-mode request's model carries a `#fast` suffix and is priced as
//!   its own row of the rates table.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

/// The collector's own directory. Fixed at `~/.claude` because that is where
/// the collector writes, whatever `NIGHTLOOM_HOME` says: the ledger is the
/// user's, not this app's, and it does not move with the config dir.
pub const CLAUDE_DIR: &str = ".claude";
pub const LEDGER_FILE: &str = "usage-ledger.csv";
pub const RATES_FILE: &str = "usage-rates.json";
pub const SURFACES_FILE: &str = "usage-surfaces.csv";
/// Named so the pane can say who fills the files; nothing here runs it.
pub const COLLECTOR: &str = "~/.claude/usage-ledger.py";

/// Where the ledger's files live, or `None` with no home directory at all.
pub fn claude_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))?;
    Some(Path::new(&home).join(CLAUDE_DIR))
}

// ---- the ledger ----

/// Which of the two counts a figure is read from. See the module note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Basis {
    Raw,
    Dedup,
}

/// One row's key. Ordered as the collector sorts its file: date, then
/// model, then scope.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Key {
    /// `YYYY-MM-DD`, UTC.
    pub date: String,
    /// The API model id, plus `#fast` for a fast-mode request.
    pub model: String,
    /// `main` or `subagent`.
    pub scope: String,
}

/// The six counters, in the collector's order.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub reqs: u64,
    /// Uncached input tokens.
    pub input: u64,
    pub output: u64,
    /// Cache writes with a one-hour TTL.
    pub w1h: u64,
    /// Cache writes with a five-minute TTL.
    pub w5m: u64,
    /// Cache reads.
    pub rd: u64,
}

/// One ledger row: both bases of the same day's traffic.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Record {
    pub raw: Counts,
    pub dedup: Counts,
}

impl Record {
    pub fn counts(&self, basis: Basis) -> &Counts {
        match basis {
            Basis::Raw => &self.raw,
            Basis::Dedup => &self.dedup,
        }
    }
}

/// The ledger in memory. `BTreeMap` so iteration is the file's order.
#[derive(Debug, Clone, Default)]
pub struct Ledger {
    pub rows: BTreeMap<Key, Record>,
}

impl Ledger {
    /// The first and last dates on record, or `None` when empty.
    pub fn span(&self) -> Option<(&str, &str)> {
        let first = self.rows.keys().next()?;
        let last = self.rows.keys().next_back()?;
        Some((&first.date, &last.date))
    }
}

/// Split one CSV line the way Python's `csv` module wrote it: commas
/// separate, a double-quoted field may hold a comma, and `""` inside quotes
/// is one quote. The ledger never needs the quoting, but the surfaces file
/// carries a model display name the app's API chose, and one day it may
/// contain a comma.
fn split_csv(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

/// A header-keyed CSV reader. Returns one map per data row; a short row
/// reads as missing columns, which the callers treat as zero or empty, as
/// the collector's `DictReader` does.
fn read_csv(text: &str) -> Vec<HashMap<String, String>> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let Some(header) = lines.next() else {
        return Vec::new();
    };
    let names = split_csv(header);
    lines
        .map(|line| {
            let fields = split_csv(line);
            names.iter().cloned().zip(fields).collect::<HashMap<_, _>>()
        })
        .collect()
}

fn count(row: &HashMap<String, String>, name: &str) -> u64 {
    row.get(name)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn counts(row: &HashMap<String, String>, basis: &str) -> Counts {
    Counts {
        reqs: count(row, &format!("reqs_{basis}")),
        input: count(row, &format!("in_{basis}")),
        output: count(row, &format!("out_{basis}")),
        w1h: count(row, &format!("w1h_{basis}")),
        w5m: count(row, &format!("w5m_{basis}")),
        rd: count(row, &format!("rd_{basis}")),
    }
}

/// Parse the ledger's text. A row missing any of the three key columns is
/// skipped rather than failing the file.
pub fn parse_ledger(text: &str) -> Ledger {
    let mut rows = BTreeMap::new();
    for row in read_csv(text) {
        let (Some(date), Some(model), Some(scope)) =
            (row.get("date"), row.get("model"), row.get("scope"))
        else {
            continue;
        };
        if date.is_empty() {
            continue;
        }
        let key = Key {
            date: date.clone(),
            model: model.clone(),
            scope: scope.clone(),
        };
        let rec = Record {
            raw: counts(&row, "raw"),
            dedup: counts(&row, "dedup"),
        };
        rows.insert(key, rec);
    }
    Ledger { rows }
}

/// Read `usage-ledger.csv` from a directory. `Err` carries the reason a
/// pane should show — the file being absent is the ordinary state on a
/// machine where the collector has never run, and reads as that sentence
/// rather than as a failure.
pub fn load_ledger_in(dir: &Path) -> Result<Ledger, String> {
    let path = dir.join(LEDGER_FILE);
    let text = fs::read_to_string(&path).map_err(|e| describe_missing(&path, e))?;
    Ok(parse_ledger(&text))
}

fn describe_missing(path: &Path, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("{} does not exist", path.display())
    } else {
        format!("cannot read {}: {e}", path.display())
    }
}

// ---- the rates ----

/// One model's prices, USD per million tokens. The cache multipliers are
/// multiples of the input rate, as the rates file's comment says.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct ModelRate {
    pub input: f64,
    pub output: f64,
    pub cache_read_mult: f64,
}

/// `usage-rates.json`. The two write multipliers default to the API's
/// published ones when absent, exactly as the collector defaults them.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Rates {
    pub models: HashMap<String, ModelRate>,
    #[serde(rename = "_write_mult_5m", default = "default_write_mult_5m")]
    pub write_mult_5m: f64,
    #[serde(rename = "_write_mult_1h", default = "default_write_mult_1h")]
    pub write_mult_1h: f64,
}

fn default_write_mult_5m() -> f64 {
    1.25
}

fn default_write_mult_1h() -> f64 {
    2.0
}

pub fn parse_rates(text: &str) -> Result<Rates, String> {
    serde_json::from_str(text).map_err(|e| format!("cannot parse the rates table: {e}"))
}

pub fn load_rates_in(dir: &Path) -> Result<Rates, String> {
    let path = dir.join(RATES_FILE);
    let text = fs::read_to_string(&path).map_err(|e| describe_missing(&path, e))?;
    parse_rates(&text)
}

/// The collector's formula, in its operation order:
///
/// ```text
/// (in·i + out·o + rd·i·crm + w5m·i·m5 + w1h·i·m1) / 1e6
/// ```
///
/// where `i`, `o`, `crm` are the model's input rate, output rate and
/// cache-read multiplier and `m5`, `m1` are the table's write multipliers.
/// `None` for a model the table does not price — which is not the same as
/// free, and the caller must not sum it as zero without saying so.
pub fn cost(rec: &Record, model: &str, basis: Basis, rates: &Rates) -> Option<f64> {
    let r = rates.models.get(model)?;
    let c = rec.counts(basis);
    let (i, o, crm) = (r.input, r.output, r.cache_read_mult);
    Some(
        (c.input as f64 * i
            + c.output as f64 * o
            + c.rd as f64 * i * crm
            + c.w5m as f64 * i * rates.write_mult_5m
            + c.w1h as f64 * i * rates.write_mult_1h)
            / 1e6,
    )
}

// ---- the next send's cache price (item 699) ----

/// What reading the cache back and writing it afresh cost for one model,
/// USD per million tokens, and where the figures came from — for the
/// composer's `next ≈ $…` estimate: the chat's context times `read` while
/// the cache is warm, times `write` (Claude Code writes the 1-hour kind)
/// once it is cold. An API-price estimate, never a bill on the plan.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CacheRates {
    pub model: String,
    pub read: f64,
    /// The 1-hour write, the kind Claude Code writes.
    pub write_1h: f64,
    pub write_5m: f64,
    /// `"rates"`: `usage-rates.json`'s row. `"pings"`: fitted to the CLI's
    /// own reported cost of the keep-warm pings on the model, every
    /// project's (`fit_cache_rates`), when the table has no row for it.
    /// `"pings_ratio"`: the same pings, all hits or all misses, fitted at
    /// the family's read : write ratio (`fit_cache_rates_ratio`).
    pub source: &'static str,
    /// How many pings the fit was made from; 0 for the table's row.
    pub pings: u32,
    /// `"pings_ratio"` only: the table row (or "the API's standard
    /// shape") whose read : write ratio the one-rate fit held
    /// (`fit_cache_rates_ratio`).
    pub ratio_from: Option<String>,
}

/// The model id as the rates table spells it: lower case, without a
/// context-size suffix the CLI may append (`claude-opus-5-5[1m]`).
pub fn rate_model(model: &str) -> String {
    let m = model.trim().to_ascii_lowercase();
    match m.find('[') {
        Some(i) => m[..i].to_string(),
        None => m,
    }
}

/// The table's row for `model`, exactly — a new model is not priced as
/// its family (nightshift backlog 182's lesson: `claude-fable-5-2` is not
/// `claude-fable-5`).
pub fn table_cache_rates(rates: &Rates, model: &str) -> Option<CacheRates> {
    let id = rate_model(model);
    let r = rates.models.get(&id)?;
    (r.input > 0.0).then_some(CacheRates {
        model: id,
        read: r.input * r.cache_read_mult,
        write_1h: r.input * rates.write_mult_1h,
        write_5m: r.input * rates.write_mult_5m,
        source: "rates",
        pings: 0,
        ratio_from: None,
    })
}

/// The read and 1-hour write rates fitted to keep-warm pings on `model`
/// (item 699), for a model the table does not price: each ping is one
/// request whose cost the CLI reported, a hit mostly read and a miss
/// mostly written, so least squares over
///
/// ```text
/// cost·1e6 = read·rd + write·(wr + in/2 + 2.5·out)
/// ```
///
/// separates the two. The small input and output terms take the API's
/// standard shape (input = write/2 at the 1-hour multiplier 2, output =
/// 5× input — `session_figures`' fallback shape). `None` without at least
/// one hit and one miss to tell the rates apart, or when the fit is not
/// positive.
pub fn fit_cache_rates(lines: &[crate::keep_warm::PingLine], model: &str) -> Option<CacheRates> {
    let id = rate_model(model);
    let (mut saa, mut sab, mut sbb, mut sac, mut sbc) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut n, mut hits, mut misses) = (0u32, 0u32, 0u32);
    for l in lines {
        let Some(cost) = l.cost_usd else { continue };
        if l.error.is_some() || cost <= 0.0 {
            continue;
        }
        if l.model.as_deref().map(rate_model).as_deref() != Some(id.as_str()) {
            continue;
        }
        let a = l.cache_read as f64;
        let b = l.cache_write as f64 + l.input as f64 / 2.0 + 2.5 * l.output as f64;
        let c = cost * 1e6;
        saa += a * a;
        sab += a * b;
        sbb += b * b;
        sac += a * c;
        sbc += b * c;
        n += 1;
        if a > b {
            hits += 1;
        } else {
            misses += 1;
        }
    }
    if hits == 0 || misses == 0 {
        return None;
    }
    let det = saa * sbb - sab * sab;
    if det <= 1e-9 * saa * sbb {
        return None;
    }
    let read = (sac * sbb - sbc * sab) / det;
    let write = (sbc * saa - sac * sab) / det;
    (read > 0.0 && write > 0.0).then_some(CacheRates {
        model: id,
        read,
        write_1h: write,
        write_5m: write * default_write_mult_5m() / default_write_mult_1h(),
        source: "pings",
        pings: n,
        ratio_from: None,
    })
}

/// The read : 1-hour-write ratio of `model`'s family (item 699, the price
/// fix of 2026-11-16), and the row it came from: the newest priced row
/// whose id shares the model's name up to its version (`claude-fable-5-1`
/// for `claude-fable-5-2`), else the API's standard shape (read 0.1×,
/// 1-hour write 2× input). Only the *ratio* is borrowed — the price level
/// still comes from the model's own pings (`fit_cache_rates_ratio`), so a
/// new model is never priced as its family (backlog 182's lesson).
pub fn family_read_ratio(rates: Option<&Rates>, model: &str) -> (f64, String) {
    let id = rate_model(model);
    let parts: Vec<&str> = id.split('-').collect();
    let keep = parts
        .iter()
        .position(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(parts.len());
    let family = parts[..keep].join("-");
    let version = |k: &str| -> Vec<u32> {
        k.strip_prefix(family.as_str())
            .unwrap_or("")
            .split('-')
            .filter_map(|p| p.parse().ok())
            .collect()
    };
    if let Some(r) = rates {
        let best = r
            .models
            .iter()
            .filter(|(k, v)| {
                k.as_str() != id
                    && !k.contains('#')
                    && v.input > 0.0
                    && v.cache_read_mult > 0.0
                    && k.strip_prefix(family.as_str())
                        .is_some_and(|rest| rest.starts_with('-'))
            })
            .max_by(|a, b| version(a.0).cmp(&version(b.0)).then_with(|| b.0.cmp(a.0)));
        if let Some((k, v)) = best {
            return (v.cache_read_mult / r.write_mult_1h, k.clone());
        }
    }
    (
        0.1 / default_write_mult_1h(),
        "the API's standard shape".to_string(),
    )
}

/// The fit for a model whose pings are all hits or all misses (item 699,
/// 2026-11-16): such pings cannot separate two rates, but with the read
/// rate held at `ratio` × the write rate (`family_read_ratio`), least
/// squares over
///
/// ```text
/// cost·1e6 = write·(ratio·rd + wr + in/2 + 2.5·out)
/// ```
///
/// gives the write rate from even a single ping. `None` with no usable
/// ping on the model.
pub fn fit_cache_rates_ratio(
    lines: &[crate::keep_warm::PingLine],
    model: &str,
    ratio: f64,
    ratio_from: &str,
) -> Option<CacheRates> {
    let id = rate_model(model);
    let (mut sxx, mut sxc, mut n) = (0.0, 0.0, 0u32);
    for l in lines {
        let Some(cost) = l.cost_usd else { continue };
        if l.error.is_some() || cost <= 0.0 {
            continue;
        }
        if l.model.as_deref().map(rate_model).as_deref() != Some(id.as_str()) {
            continue;
        }
        let x = ratio * l.cache_read as f64
            + l.cache_write as f64
            + l.input as f64 / 2.0
            + 2.5 * l.output as f64;
        sxx += x * x;
        sxc += x * cost * 1e6;
        n += 1;
    }
    if n == 0 || sxx <= 0.0 {
        return None;
    }
    let write = sxc / sxx;
    (write > 0.0).then_some(CacheRates {
        model: id,
        read: write * ratio,
        write_1h: write,
        write_5m: write * default_write_mult_5m() / default_write_mult_1h(),
        source: "pings_ratio",
        pings: n,
        ratio_from: Some(ratio_from.to_string()),
    })
}

/// The table's row, else the two-rate fit over `pings`, else (all hits or
/// all misses) the fit at the family's read : write ratio (item 699).
pub fn cache_rates_with(
    rates: Option<&Rates>,
    pings: &[crate::keep_warm::PingLine],
    model: &str,
) -> Option<CacheRates> {
    rates
        .and_then(|r| table_cache_rates(r, model))
        .or_else(|| fit_cache_rates(pings, model))
        .or_else(|| {
            let (ratio, from) = family_read_ratio(rates, model);
            fit_cache_rates_ratio(pings, model, ratio, &from)
        })
}

// ---- the surfaces ----

/// One snapshot of the desktop app's seven-day breakdown. Percents are of
/// **weekly rate-limit utilization** — cost-weighted, integer-rounded, and
/// not dollars; the collector's docstring is explicit that the figures
/// derived from them are estimates. Empty strings in the file read as
/// `None`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SurfaceRow {
    /// `YYYY-MM-DDTHH:MM:SS`, UTC.
    pub as_of: String,
    pub window_started_at: String,
    pub claude_code_pct: Option<f64>,
    pub chat_pct: Option<f64>,
    pub cowork_pct: Option<f64>,
    pub other_pct: Option<f64>,
    /// The all-models weekly limit's fill.
    pub weekly_all_pct: Option<f64>,
    /// The per-model weekly limit: which model it scopes, and its fill.
    pub weekly_scoped_model: String,
    pub weekly_scoped_pct: Option<f64>,
}

fn pct(row: &HashMap<String, String>, name: &str) -> Option<f64> {
    row.get(name)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse().ok())
}

/// Parse `usage-surfaces.csv`, oldest first (the collector sorts by `as_of`
/// on every write, and that string sorts chronologically).
pub fn parse_surfaces(text: &str) -> Vec<SurfaceRow> {
    let mut rows: Vec<SurfaceRow> = read_csv(text)
        .into_iter()
        .filter_map(|row| {
            let as_of = row.get("as_of")?.clone();
            if as_of.is_empty() {
                return None;
            }
            Some(SurfaceRow {
                as_of,
                window_started_at: row.get("window_started_at").cloned().unwrap_or_default(),
                claude_code_pct: pct(&row, "claude_code_pct"),
                chat_pct: pct(&row, "chat_pct"),
                cowork_pct: pct(&row, "cowork_pct"),
                other_pct: pct(&row, "other_pct"),
                weekly_all_pct: pct(&row, "weekly_all_pct"),
                weekly_scoped_model: row.get("weekly_scoped_model").cloned().unwrap_or_default(),
                weekly_scoped_pct: pct(&row, "weekly_scoped_pct"),
            })
        })
        .collect();
    rows.sort_by(|a, b| a.as_of.cmp(&b.as_of));
    rows
}

pub fn load_surfaces_in(dir: &Path) -> Result<Vec<SurfaceRow>, String> {
    let path = dir.join(SURFACES_FILE);
    let text = fs::read_to_string(&path).map_err(|e| describe_missing(&path, e))?;
    Ok(parse_surfaces(&text))
}

// ---- the summary a pane shows ----

/// One model's share of a window, both scopes folded together.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelSpend {
    pub model: String,
    pub usd: f64,
    pub reqs: u64,
    pub output: u64,
    /// True when the rates table has no row for it: `usd` is then zero and
    /// means "unpriced", not "free".
    pub unpriced: bool,
}

/// A window of days, dedup basis.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WindowSpend {
    /// `YYYY-MM-DD`, UTC, inclusive.
    pub from: String,
    pub to: String,
    /// Days in the window that have at least one row.
    pub days_with_data: u32,
    pub usd: f64,
    /// Sorted by `usd`, largest first.
    pub by_model: Vec<ModelSpend>,
}

/// Everything Settings → Usage shows. `available == false` carries `reason`
/// and empty windows; the pane renders the reason and nothing breaks.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageSummary {
    pub available: bool,
    /// Why there is nothing to show, when there is nothing to show.
    pub reason: Option<String>,
    pub dir: String,
    pub collector: String,
    /// The ledger's first and last dates.
    pub first_date: Option<String>,
    pub last_date: Option<String>,
    /// When the ledger file was last written, RFC 3339 UTC — the CSV's
    /// mtime, which is when the collector last ran to completion.
    pub updated_at: Option<String>,
    pub today: Option<WindowSpend>,
    pub week: Option<WindowSpend>,
    pub month: Option<WindowSpend>,
    /// The newest surfaces snapshot, if any.
    pub surfaces: Option<SurfaceRow>,
    /// Models the ledger counted that the rates table does not price.
    pub unpriced_models: Vec<String>,
}

impl UsageSummary {
    fn unavailable(dir: &Path, reason: String) -> Self {
        Self {
            available: false,
            reason: Some(reason),
            dir: dir.to_string_lossy().into_owned(),
            collector: COLLECTOR.to_string(),
            first_date: None,
            last_date: None,
            updated_at: None,
            today: None,
            week: None,
            month: None,
            surfaces: None,
            unpriced_models: Vec::new(),
        }
    }
}

/// Sum a window of UTC days, dedup basis, folding both scopes into each
/// model. Unpriced models are listed with `usd == 0.0` and `unpriced` set
/// rather than dropped, so a day on an unpriced model is not shown as a
/// cheap day.
pub fn window(ledger: &Ledger, rates: &Rates, from: NaiveDate, to: NaiveDate) -> WindowSpend {
    let lo = from.format("%Y-%m-%d").to_string();
    let hi = to.format("%Y-%m-%d").to_string();
    let mut by_model: BTreeMap<&str, ModelSpend> = BTreeMap::new();
    let mut days = std::collections::BTreeSet::new();
    for (key, rec) in &ledger.rows {
        if key.date < lo || key.date > hi {
            continue;
        }
        days.insert(key.date.as_str());
        let c = cost(rec, &key.model, Basis::Dedup, rates);
        let entry = by_model.entry(&key.model).or_insert_with(|| ModelSpend {
            model: key.model.clone(),
            usd: 0.0,
            reqs: 0,
            output: 0,
            unpriced: c.is_none(),
        });
        entry.usd += c.unwrap_or(0.0);
        entry.reqs += rec.dedup.reqs;
        entry.output += rec.dedup.output;
    }
    let mut by_model: Vec<ModelSpend> = by_model.into_values().collect();
    by_model.sort_by(|a, b| {
        b.usd
            .partial_cmp(&a.usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    WindowSpend {
        from: lo,
        to: hi,
        days_with_data: days.len() as u32,
        // A fold from +0.0 rather than `sum()`: the latter starts from -0.0,
        // and an empty window would reach the pane as "-$0.00".
        usd: by_model.iter().fold(0.0, |acc, m| acc + m.usd),
        by_model,
    }
}

/// The summary for a directory, as of a given UTC date — a parameter so a
/// test can pin "today". Rates and ledger both have to load; the surfaces
/// file is optional and its absence costs only that card.
pub fn summary_in(dir: &Path, today: NaiveDate) -> UsageSummary {
    let ledger = match load_ledger_in(dir) {
        Ok(l) => l,
        Err(reason) => return UsageSummary::unavailable(dir, reason),
    };
    let rates = match load_rates_in(dir) {
        Ok(r) => r,
        Err(reason) => return UsageSummary::unavailable(dir, reason),
    };
    if ledger.rows.is_empty() {
        return UsageSummary::unavailable(
            dir,
            format!("{} has no rows yet", dir.join(LEDGER_FILE).display()),
        );
    }
    let updated_at = fs::metadata(dir.join(LEDGER_FILE))
        .and_then(|m| m.modified())
        .ok()
        .map(|t| DateTime::<Utc>::from(t).to_rfc3339());
    let (first, last) = ledger
        .span()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .unwrap_or_default();
    let mut unpriced: Vec<String> = ledger
        .rows
        .keys()
        .filter(|k| !rates.models.contains_key(&k.model))
        .map(|k| k.model.clone())
        .collect();
    unpriced.sort();
    unpriced.dedup();
    let surfaces = load_surfaces_in(dir)
        .ok()
        .and_then(|rows| rows.into_iter().last());
    UsageSummary {
        available: true,
        reason: None,
        dir: dir.to_string_lossy().into_owned(),
        collector: COLLECTOR.to_string(),
        first_date: Some(first),
        last_date: Some(last),
        updated_at,
        today: Some(window(&ledger, &rates, today, today)),
        week: Some(window(&ledger, &rates, today - Duration::days(6), today)),
        month: Some(window(&ledger, &rates, today - Duration::days(29), today)),
        surfaces,
        unpriced_models: unpriced,
    }
}

/// The summary for this machine, as of today in UTC (the ledger's clock).
pub fn summary() -> UsageSummary {
    let Some(dir) = claude_dir() else {
        return UsageSummary::unavailable(
            Path::new("~/.claude"),
            "no home directory, so nowhere the collector could have written".to_string(),
        );
    };
    let now = Utc::now();
    let today = NaiveDate::from_ymd_opt(now.year(), now.month(), now.day())
        .expect("a valid date from the clock");
    summary_in(&dir, today)
}

/// Run the collector once, now — `python3 ~/.claude/usage-ledger.py update`
/// — and wait for it. The LaunchAgent runs the same command every six
/// hours; this is the button for "I want the number now" (his ask,
/// 2026-09-14: the ledger had a scheduled update and no manual one). The
/// collector rescans the last 45 days of transcripts and the desktop app's
/// cache, takes a few seconds, and is the only thing that writes the ledger
/// — Nightloom still writes nothing itself. Returns the collector's last
/// output line on success and its stderr on failure.
pub fn refresh() -> Result<String, String> {
    let dir = claude_dir().ok_or("no home directory")?;
    let script = dir.join("usage-ledger.py");
    if !script.is_file() {
        return Err(format!("no collector at {}", script.display()));
    }
    let out = std::process::Command::new("python3")
        .arg(&script)
        .arg("update")
        .output()
        .map_err(|e| format!("could not run the collector: {e}"))?;
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(text.lines().last().unwrap_or("updated").to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!(
            "the collector exited {}: {}",
            out.status.code().unwrap_or(-1),
            err.lines().last().unwrap_or("no output")
        ))
    }
}

#[cfg(test)]
mod tests {
    // ---- item 699: the next send's cache price ----

    fn ping(read: u64, write: u64, cost: f64, model: &str) -> crate::keep_warm::PingLine {
        crate::keep_warm::PingLine {
            sent_ms: 0,
            cache_read: read,
            cache_write: write,
            input: 4,
            output: 6,
            cost_usd: Some(cost),
            model: Some(model.into()),
            context: read.max(write),
            hit: read > write,
            error: None,
        }
    }

    #[test]
    fn a_priced_model_reads_its_table_row_exactly() {
        let rates = parse_rates(RATES).unwrap();
        let r = table_cache_rates(&rates, "claude-opus-5[1m]").unwrap();
        assert_eq!(r.source, "rates");
        assert!((r.read - 0.5).abs() < 1e-9, "{}", r.read);
        assert!((r.write_1h - 10.0).abs() < 1e-9);
        assert!((r.write_5m - 6.25).abs() < 1e-9);
        // A new model is not priced as its family.
        assert_eq!(table_cache_rates(&rates, "claude-fable-5-2"), None);
    }

    #[test]
    fn an_unpriced_model_is_fitted_to_its_pings() {
        // Made at read $0.20 / write $16 per MTok, input $8, output $40.
        let cost =
            |rd: u64, wr: u64| (rd as f64 * 0.2 + wr as f64 * 16.0 + 4.0 * 8.0 + 6.0 * 40.0) / 1e6;
        let lines = vec![
            ping(269_000, 900, cost(269_000, 900), "claude-fable-5-2"),
            ping(120_000, 1_500, cost(120_000, 1_500), "claude-fable-5-2"),
            ping(0, 269_843, cost(0, 269_843), "claude-fable-5-2"),
            // Another model's ping is not this one's evidence.
            ping(0, 100_000, 99.0, "claude-opus-5-5"),
        ];
        let r = cache_rates_with(None, &lines, "claude-fable-5-2").unwrap();
        assert_eq!(r.source, "pings");
        assert_eq!(r.pings, 3);
        assert!((r.read - 0.2).abs() < 1e-6, "{}", r.read);
        assert!((r.write_1h - 16.0).abs() < 1e-6, "{}", r.write_1h);
        // Hits alone cannot tell the write rate: no figure, not a guess.
        assert_eq!(fit_cache_rates(&lines[..2], "claude-fable-5-2"), None);
    }

    /// The price fix (2026-11-16, his bug "it doesnt say like what the
    /// price of cache is"): a Fable 5.2 chat whose project's pings were all
    /// hits got `None`, and the chip no price. With the family's read :
    /// write ratio held, hits alone (or a lone miss) price it.
    #[test]
    fn an_unpriced_model_with_only_hits_still_gets_a_price() {
        let rates = parse_rates(
            r#"{"_write_mult_1h": 2.0, "models": {
                "claude-fable-5": {"input": 10, "output": 50, "cache_read_mult": 0.1},
                "claude-fable-5-1": {"input": 10, "output": 50, "cache_read_mult": 0.025},
                "claude-fable-5-1#fast": {"input": 20, "output": 100, "cache_read_mult": 0.5}}}"#,
        )
        .unwrap();
        // The newest priced sibling's ratio, never the fast row's.
        let (ratio, from) = family_read_ratio(Some(&rates), "claude-fable-5-2[1m]");
        assert_eq!(from, "claude-fable-5-1");
        assert!((ratio - 0.025 / 2.0).abs() < 1e-12);
        // No sibling: the API's standard shape.
        let (r2, from2) = family_read_ratio(Some(&rates), "claude-haiku-5-5");
        assert_eq!(from2, "the API's standard shape");
        assert!((r2 - 0.05).abs() < 1e-12);

        // Shaped on his real pings (keep-warm.jsonl, 2026-11-16), priced
        // at the rates the two-rate fit finds there: read $0.20 / write $16.
        let cost =
            |rd: u64, wr: u64| (rd as f64 * 0.2 + wr as f64 * 16.0 + 4.0 * 8.0 + 6.0 * 40.0) / 1e6;
        let hits = vec![
            ping(96_892, 4_418, cost(96_892, 4_418), "claude-fable-5-2"),
            ping(49_755, 2_315, cost(49_755, 2_315), "claude-fable-5-2"),
        ];
        assert_eq!(fit_cache_rates(&hits, "claude-fable-5-2"), None);
        let r = cache_rates_with(Some(&rates), &hits, "claude-fable-5-2").unwrap();
        assert_eq!(r.source, "pings_ratio");
        assert_eq!(r.pings, 2);
        assert_eq!(r.ratio_from.as_deref(), Some("claude-fable-5-1"));
        assert!((r.write_1h - 16.0).abs() < 0.2, "{}", r.write_1h);
        assert!((r.read - 0.2).abs() < 0.01, "{}", r.read);
        // A lone miss prices it too.
        let miss = vec![ping(
            12_779,
            269_854,
            cost(12_779, 269_854),
            "claude-fable-5-2",
        )];
        let m = cache_rates_with(Some(&rates), &miss, "claude-fable-5-2").unwrap();
        assert!((m.write_1h - 16.0).abs() < 0.1, "{}", m.write_1h);
        // No ping on the model at all: still no figure, not a guess.
        assert_eq!(
            cache_rates_with(Some(&rates), &hits, "claude-fable-6"),
            None
        );
    }

    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "nightloom-usage-{label}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The real `~/.claude/usage-rates.json` as it stood on 2026-09-14.
    const RATES: &str = r#"{
  "_comment": "USD per 1M tokens. cache_read_mult/write mults are multiples of the input rate.",
  "_write_mult_5m": 1.25,
  "_write_mult_1h": 2.0,
  "models": {
    "claude-opus-5":              {"input": 5,  "output": 25, "cache_read_mult": 0.1},
    "claude-opus-5#fast":         {"input": 10, "output": 50, "cache_read_mult": 0.1},
    "claude-fable-5-1":           {"input": 10, "output": 50, "cache_read_mult": 0.025},
    "claude-fable-5":             {"input": 10, "output": 50, "cache_read_mult": 0.1},
    "claude-sonnet-5":            {"input": 2,  "output": 10, "cache_read_mult": 0.1},
    "claude-sonnet-4-6":          {"input": 3,  "output": 15, "cache_read_mult": 0.1},
    "claude-haiku-4-5-20251001":  {"input": 1,  "output": 5,  "cache_read_mult": 0.1},
    "claude-haiku-4-5":           {"input": 1,  "output": 5,  "cache_read_mult": 0.1},
    "claude-probe":               {"input": 0,  "output": 0,  "cache_read_mult": 0},
    "<synthetic>":                {"input": 0,  "output": 0,  "cache_read_mult": 0}
  }
}"#;

    /// The header and first rows of the real `~/.claude/usage-ledger.csv`
    /// (2026-09-14), plus the four rows of 2026-09-13 — the day the
    /// cross-check test prices.
    const LEDGER: &str = "\
date,model,scope,reqs_raw,in_raw,out_raw,w1h_raw,w5m_raw,rd_raw,reqs_dedup,in_dedup,out_dedup,w1h_dedup,w5m_dedup,rd_dedup
2026-07-24,claude-opus-5,main,49,91,47325,110986,0,1998209,20,37,17475,41169,0,820457
2026-07-25,claude-opus-5,main,106,195,72513,114753,0,8350387,45,82,27315,44222,0,3596338
2026-08-04,claude-opus-5,main,127,1649,53882,281240,0,11503388,69,1541,30485,124544,0,6372586
2026-08-07,claude-opus-5,main,10,19,2926,256906,0,1142284,6,11,2166,129195,0,711915
2026-08-15,<synthetic>,main,1,0,0,0,0,0,1,0,0,0,0,0
2026-09-13,<synthetic>,main,4,0,0,0,0,0,2,0,0,0,0,0
2026-09-13,claude-fable-5-1,main,648,16776,1431888,9815566,0,100430750,89,2398,179405,1169071,0,17011463
2026-09-13,claude-fable-5-1,subagent,242,7264,102600,0,3907850,41463274,24,678,50892,0,302420,4244930
2026-09-13,claude-opus-5,main,1761,3542,1442985,8717258,0,397926508,494,994,350799,2005785,0,113289714
";

    /// The real `~/.claude/usage-surfaces.csv` on 2026-09-14.
    const SURFACES: &str = "\
as_of,window_started_at,claude_code_pct,chat_pct,cowork_pct,other_pct,weekly_all_pct,weekly_scoped_model,weekly_scoped_pct
2026-09-12T02:08:44,2026-09-09T09:59:59,92,8,0,0,30,Fable,40
2026-09-12T02:23:44,2026-09-09T10:00:00,92,8,0,0,31,Fable,43
2026-09-14T23:13:50,2026-09-09T10:00:00,92,8,0,0,63,Fable,74
2026-09-14T23:17:21,2026-09-09T10:00:00,92,8,0,0,63,Fable,74
";

    fn key(date: &str, model: &str, scope: &str) -> Key {
        Key {
            date: date.into(),
            model: model.into(),
            scope: scope.into(),
        }
    }

    #[test]
    fn the_ledger_parses_with_both_bases_and_the_file_order() {
        let led = parse_ledger(LEDGER);
        assert_eq!(led.rows.len(), 9);
        let first = &led.rows[&key("2026-07-24", "claude-opus-5", "main")];
        assert_eq!(first.raw.reqs, 49);
        assert_eq!(first.raw.rd, 1_998_209);
        assert_eq!(first.dedup.reqs, 20);
        assert_eq!(first.dedup.w1h, 41_169);
        assert_eq!(first.dedup.w5m, 0);
        assert_eq!(led.span(), Some(("2026-07-24", "2026-09-13")));
        // Two scopes on one day are two rows, not one.
        assert!(
            led.rows
                .contains_key(&key("2026-09-13", "claude-fable-5-1", "subagent"))
        );
        assert!(
            led.rows
                .contains_key(&key("2026-09-13", "claude-fable-5-1", "main"))
        );
    }

    #[test]
    fn the_rates_parse_with_the_two_write_multipliers() {
        let rates = parse_rates(RATES).unwrap();
        assert_eq!(rates.write_mult_5m, 1.25);
        assert_eq!(rates.write_mult_1h, 2.0);
        assert_eq!(rates.models.len(), 10);
        let fast = &rates.models["claude-opus-5#fast"];
        assert_eq!(
            (fast.input, fast.output, fast.cache_read_mult),
            (10.0, 50.0, 0.1)
        );
        // The multipliers default when the file omits them, as the collector's do.
        let bare = parse_rates(r#"{"models": {}}"#).unwrap();
        assert_eq!((bare.write_mult_5m, bare.write_mult_1h), (1.25, 2.0));
    }

    /// Pinned to the collector:
    /// `python3 ~/.claude/usage-ledger.py report --from 2026-07-24 --to 2026-07-24 --basis dedup`
    /// printed `$1.26` on 2026-09-14, and its `cost()` returned
    /// `1.2589785` for that row.
    #[test]
    fn cost_of_the_first_real_row_matches_the_python() {
        let led = parse_ledger(LEDGER);
        let rates = parse_rates(RATES).unwrap();
        let rec = &led.rows[&key("2026-07-24", "claude-opus-5", "main")];
        let usd = cost(rec, "claude-opus-5", Basis::Dedup, &rates).unwrap();
        assert!((usd - 1.2589785).abs() < 1e-9, "{usd}");
        assert_eq!(format!("{usd:.2}"), "1.26");
    }

    /// Pinned to the collector on a whole real day:
    /// `python3 ~/.claude/usage-ledger.py report --from 2026-09-13 --to 2026-09-13 --basis dedup`
    /// printed, on 2026-09-14:
    ///
    /// ```text
    ///   claude-opus-5             main           494     350,799  56.5:1     $85.48
    ///   claude-fable-5-1          main            89     179,405  14.6:1     $36.63
    ///   claude-fable-5-1          subagent        24      50,892  14.0:1      $7.39
    ///   <synthetic>               main             2           0       -      $0.00
    ///   TOTAL                                                               $129.50
    /// ```
    ///
    /// and its `cost()` gave 85.477652, 36.62851575, 7.3928625 and 0.0,
    /// total 129.49903025.
    #[test]
    fn a_real_day_costs_what_the_python_report_prints() {
        let led = parse_ledger(LEDGER);
        let rates = parse_rates(RATES).unwrap();
        let c = |model: &str, scope: &str| {
            cost(
                &led.rows[&key("2026-09-13", model, scope)],
                model,
                Basis::Dedup,
                &rates,
            )
            .unwrap()
        };
        assert!((c("claude-opus-5", "main") - 85.477652).abs() < 1e-9);
        assert!((c("claude-fable-5-1", "main") - 36.62851575).abs() < 1e-9);
        assert!((c("claude-fable-5-1", "subagent") - 7.3928625).abs() < 1e-9);
        assert_eq!(c("<synthetic>", "main"), 0.0);
        let day = NaiveDate::from_ymd_opt(2026, 9, 13).unwrap();
        let w = window(&led, &rates, day, day);
        assert!((w.usd - 129.49903025).abs() < 1e-9, "{}", w.usd);
        assert_eq!(format!("{:.2}", w.usd), "129.50");
        assert_eq!(w.days_with_data, 1);
        // Both fable scopes fold into one line; largest first.
        assert_eq!(w.by_model.len(), 3);
        assert_eq!(w.by_model[0].model, "claude-opus-5");
        assert_eq!(w.by_model[1].model, "claude-fable-5-1");
        assert!((w.by_model[1].usd - (36.62851575 + 7.3928625)).abs() < 1e-9);
        assert_eq!(w.by_model[1].reqs, 89 + 24);
    }

    #[test]
    fn raw_basis_is_the_dashboards_larger_number() {
        let led = parse_ledger(LEDGER);
        let rates = parse_rates(RATES).unwrap();
        let rec = &led.rows[&key("2026-09-13", "claude-opus-5", "main")];
        let raw = cost(rec, "claude-opus-5", Basis::Raw, &rates).unwrap();
        let dedup = cost(rec, "claude-opus-5", Basis::Dedup, &rates).unwrap();
        assert!(raw > 2.0 * dedup, "raw {raw} vs dedup {dedup}");
    }

    #[test]
    fn an_unpriced_model_is_none_not_zero() {
        let led = parse_ledger(LEDGER);
        let rates = parse_rates(RATES).unwrap();
        let rec = &led.rows[&key("2026-07-24", "claude-opus-5", "main")];
        assert_eq!(cost(rec, "claude-opus-6", Basis::Dedup, &rates), None);
        // A fast-mode row is priced by its own suffixed row, at double.
        let fast = cost(rec, "claude-opus-5#fast", Basis::Dedup, &rates).unwrap();
        let plain = cost(rec, "claude-opus-5", Basis::Dedup, &rates).unwrap();
        assert!((fast - 2.0 * plain).abs() < 1e-9);
    }

    #[test]
    fn surfaces_parse_and_the_newest_is_last() {
        let rows = parse_surfaces(SURFACES);
        assert_eq!(rows.len(), 4);
        let last = rows.last().unwrap();
        assert_eq!(last.as_of, "2026-09-14T23:17:21");
        assert_eq!(last.claude_code_pct, Some(92.0));
        assert_eq!(last.chat_pct, Some(8.0));
        assert_eq!(last.weekly_all_pct, Some(63.0));
        assert_eq!(last.weekly_scoped_model, "Fable");
        assert_eq!(last.weekly_scoped_pct, Some(74.0));
        // An empty cell is None, not zero.
        let blank = parse_surfaces(
            "as_of,window_started_at,claude_code_pct,chat_pct,cowork_pct,other_pct,weekly_all_pct,weekly_scoped_model,weekly_scoped_pct\n2026-09-01T00:00:00,,92,8,,,,,\n",
        );
        assert_eq!(blank[0].cowork_pct, None);
        assert_eq!(blank[0].weekly_scoped_model, "");
    }

    #[test]
    fn a_quoted_csv_field_keeps_its_comma() {
        assert_eq!(split_csv(r#"a,"b,c",d"#), vec!["a", "b,c", "d"]);
        assert_eq!(
            split_csv(r#"a,"say ""hi""",d"#),
            vec!["a", r#"say "hi""#, "d"]
        );
        assert_eq!(split_csv("a,,c"), vec!["a", "", "c"]);
    }

    #[test]
    fn a_missing_ledger_is_a_reason_not_an_error() {
        let dir = temp_dir("missing");
        let s = summary_in(&dir, NaiveDate::from_ymd_opt(2026, 9, 14).unwrap());
        assert!(!s.available);
        assert!(s.reason.as_deref().unwrap().contains("usage-ledger.csv"));
        assert!(s.today.is_none());
        assert_eq!(s.collector, COLLECTOR);
        // A ledger without a rates table is the other reason.
        fs::write(dir.join(LEDGER_FILE), LEDGER).unwrap();
        let s = summary_in(&dir, NaiveDate::from_ymd_opt(2026, 9, 14).unwrap());
        assert!(!s.available);
        assert!(s.reason.as_deref().unwrap().contains("usage-rates.json"));
    }

    #[test]
    fn the_summary_windows_are_today_seven_and_thirty_days() {
        let dir = temp_dir("summary");
        fs::write(dir.join(LEDGER_FILE), LEDGER).unwrap();
        fs::write(dir.join(RATES_FILE), RATES).unwrap();
        fs::write(dir.join(SURFACES_FILE), SURFACES).unwrap();
        // "Today" is the day after the last row, so today is empty, the week
        // holds 2026-09-13, and the month holds nothing older than 08-16.
        let s = summary_in(&dir, NaiveDate::from_ymd_opt(2026, 9, 14).unwrap());
        assert!(s.available, "{:?}", s.reason);
        assert_eq!(s.first_date.as_deref(), Some("2026-07-24"));
        assert_eq!(s.last_date.as_deref(), Some("2026-09-13"));
        assert!(s.updated_at.is_some());
        let today = s.today.unwrap();
        assert_eq!(
            (today.from.as_str(), today.to.as_str()),
            ("2026-09-14", "2026-09-14")
        );
        assert_eq!(today.usd, 0.0);
        assert!(
            !today.usd.is_sign_negative(),
            "an empty window is +0.0, not -0.0"
        );
        assert_eq!(today.days_with_data, 0);
        let week = s.week.unwrap();
        assert_eq!(week.from, "2026-09-08");
        assert!((week.usd - 129.49903025).abs() < 1e-9);
        let month = s.month.unwrap();
        assert_eq!(month.from, "2026-08-16");
        assert!((month.usd - 129.49903025).abs() < 1e-9);
        assert_eq!(s.surfaces.unwrap().as_of, "2026-09-14T23:17:21");
        assert!(s.unpriced_models.is_empty());
        // Widen "today" back to July and every row is in the month window.
        let s = summary_in(&dir, NaiveDate::from_ymd_opt(2026, 8, 15).unwrap());
        assert_eq!(s.month.unwrap().days_with_data, 5);
    }

    #[test]
    fn an_unpriced_model_is_listed_and_flagged_not_summed_as_free() {
        let dir = temp_dir("unpriced");
        fs::write(
            dir.join(LEDGER_FILE),
            "date,model,scope,reqs_dedup,in_dedup,out_dedup,w1h_dedup,w5m_dedup,rd_dedup\n2026-09-13,claude-opus-6,main,3,100,100,0,0,0\n",
        )
        .unwrap();
        fs::write(dir.join(RATES_FILE), RATES).unwrap();
        let s = summary_in(&dir, NaiveDate::from_ymd_opt(2026, 9, 13).unwrap());
        assert!(s.available);
        assert_eq!(s.unpriced_models, vec!["claude-opus-6".to_string()]);
        let today = s.today.unwrap();
        assert_eq!(today.usd, 0.0);
        assert!(today.by_model[0].unpriced);
        assert_eq!(today.by_model[0].reqs, 3);
    }
}
