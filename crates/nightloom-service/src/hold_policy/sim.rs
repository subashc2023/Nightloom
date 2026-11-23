//! The scoreboard (item 878): every keep-warm rule replayed on his idle
//! moments, walk-forward — each week decided from the weeks before it
//! only — and scored as items 541/579 scored keep-warm (`replay.py`'s
//! `money`/`score`): k pings, each reading the context and writing a
//! little; a gap that needed no more than k saves the rebuild. The
//! headline is net list dollars with cache reads at item 580's measured
//! weight 0.5. A port of `notes/runner-design/aside-cache-hold-sim.py`
//! (nightshift-code), checked against its output on his data (±1%,
//! `examples/hold_sim_parity.rs`).

use super::gaps::Gap;
use super::{
    At, MAX_PINGS, PING_OUT, PING_WRITE, Rule, SLEEP_HOURS, Sleep, hz_key, local_hw, prices,
    sleep_window,
};
use serde::{Deserialize, Serialize};

pub const WEEK_S: i64 = 7 * 86_400;
const EVERY_S: i64 = 55 * 60;
/// A fold counts once it has this many earlier moments to learn from.
pub const MIN_TRAIN: usize = 50;
/// Weeks the table and the overtake test add up (fewer while there are fewer).
pub const WINDOW_WEEKS: usize = 4;
/// An overtake needs at least this many weeks, and a win in each of the
/// last this many (his "over the last 2+ weeks").
pub const OVERTAKE_WEEKS: usize = 2;

/// Pings a flat cap of `h` hours allows: floor(h · 60 / 55).
pub fn cap_k(h: u32) -> u32 {
    h * 60 / 55
}

/// Every rule the table scores, in its order: (id, the sim's label).
/// The last, perfect foresight, is the ceiling and never selectable.
pub const POLICIES: [(&str, &str); 18] = [
    ("flat-6", "flat 6 h (item 541's cap)"),
    ("flat-3", "flat 3 h"),
    ("flat-4", "flat 4 h"),
    ("flat-8", "flat 8 h"),
    ("flat-12", "flat 12 h"),
    ("flat-24", "flat 24 h"),
    ("flat-tuned", "flat cap tuned on the past"),
    ("sleep-cut", "stop at your sleep, 6 h awake"),
    (
        "sleep-cut-6w",
        "stop at your sleep (6-h sleep window), 6 h awake",
    ),
    (
        "sleep-cut-8w",
        "stop at your sleep (8-h sleep window), 6 h awake",
    ),
    ("sleep-cut-8h", "stop at your sleep, up to 8 h awake"),
    (
        "sleep-extend-1",
        "run on through your sleep to waking + 1 h",
    ),
    (
        "sleep-extend-3",
        "run on through your sleep to waking + 3 h",
    ),
    (
        "hybrid",
        "none if the reply lands in your sleep, else run on",
    ),
    ("daypart", "a cap per weekday/weekend × 6-h part of the day"),
    (
        "expected-hit",
        "ping while a return is likely enough (by weekday × 3 h)",
    ),
    ("expected-hit-light", "the same, reads counted light (0.2)"),
    ("foresight", "perfect foresight (the ceiling)"),
];
pub const FORESIGHT: &str = "foresight";

/// Whether `id` is a rule he can switch to.
pub fn selectable(id: &str) -> bool {
    id != FORESIGHT && POLICIES.iter().any(|(p, _)| *p == id)
}

/// The label of `id` (the id itself when unknown).
pub fn name_of(id: &str) -> String {
    POLICIES
        .iter()
        .find(|(p, _)| *p == id)
        .map_or_else(|| id.to_string(), |(_, n)| (*n).to_string())
}

/// What the rules learn from a stretch of his past.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Learned {
    pub sleep7: Sleep,
    pub sleep6: Sleep,
    pub sleep8: Sleep,
    pub best_k: u32,
    /// Pings per (weekend 0 / weekday 1) × 6-h part; `u8::MAX` with no past.
    pub daypart: [u8; 8],
    /// (still open at a ping, ended before the next) per weekday-or-weekend × 3-h part.
    pub hz: [(u16, u16); 16],
}

impl Default for Learned {
    fn default() -> Self {
        Self {
            sleep7: super::DEFAULT_SLEEP,
            sleep6: Sleep { start: 2, end: 8 },
            sleep8: Sleep { start: 2, end: 10 },
            best_k: cap_k(6),
            daypart: [u8::MAX; 8],
            hz: [(0, 0); 16],
        }
    }
}

/// (net $, read $, other $, saved $) for `k` pings on `g` (replay.py's `money`).
pub fn money(g: &Gap, k: u32) -> (f64, f64, f64, f64) {
    let (rd, w, o) = prices(g.fable);
    let c = g.ctx as f64;
    let k = f64::from(k);
    let read = k * c * rd / 1e6;
    let other = k * (PING_WRITE * w + PING_OUT * o) / 1e6;
    let save = if g.need() as f64 <= k {
        c * (w - rd) / 1e6
    } else {
        0.0
    };
    (save - read - other, read, other, save)
}

/// Perfect foresight: exactly the pings a return needs, when they pay.
pub fn oracle(g: &Gap) -> u32 {
    if g.censored {
        return 0;
    }
    if money(g, g.need()).0 > 0.0 {
        g.need()
    } else {
        0
    }
}

/// A policy's score over some moments.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Score {
    pub avoided: u32,
    pub pings: u32,
    /// Net list $, reads at full price.
    pub usd: f64,
    /// Net list $, reads at 0.5 (item 580) — the headline.
    pub half: f64,
    pub pts_light: f64,
    pub wk: f64,
    pub wk_light: f64,
}

impl Score {
    fn add(&mut self, o: &Score) {
        self.avoided += o.avoided;
        self.pings += o.pings;
        self.usd += o.usd;
        self.half += o.half;
        self.pts_light += o.pts_light;
        self.wk += o.wk;
        self.wk_light += o.wk_light;
    }
}

/// replay.py's `score`, plus the 0.5 read weight.
pub fn score(gs: &[&Gap], ks: &[u32]) -> Score {
    let (mut net, mut read, mut other, mut save, mut half) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut avoided, mut pings) = (0, 0);
    for (g, &k) in gs.iter().zip(ks) {
        let (n, a, b, s) = money(g, k);
        net += n;
        read += a;
        other += b;
        save += s;
        half += s - b - 0.5 * a;
        avoided += u32::from(s > 0.0);
        pings += k;
    }
    Score {
        avoided,
        pings,
        usd: net,
        half,
        pts_light: 1.3 * (save - other - 0.15 * read),
        wk: 0.17 * net,
        wk_light: 0.17 * (save - other - 0.25 * read),
    }
}

fn at_of(g: &Gap) -> At {
    At {
        t0_ms: g.t0 * 1000,
        ctx: g.ctx,
        fable: g.fable,
    }
}

fn hour_of_s(t: f64) -> u32 {
    local_hw((t * 1000.0) as i64).0
}

/// Hour-of-day activity: each reply's end and each return.
pub fn profile(train: &[&Gap]) -> [u32; 24] {
    let mut c = [0u32; 24];
    for g in train {
        c[hour_of_s(g.t0 as f64) as usize] += 1;
        if !g.censored {
            c[hour_of_s(g.t0 as f64 + g.gap_min * 60.0) as usize] += 1;
        }
    }
    c
}

fn best_k(train: &[&Gap]) -> u32 {
    if train.is_empty() {
        return cap_k(6);
    }
    let mut best = (0, f64::NEG_INFINITY);
    for k in 0..=MAX_PINGS {
        let v: f64 = train.iter().map(|g| money(g, k).0).sum();
        if v > best.1 {
            best = (k, v);
        }
    }
    best.0
}

fn hazards(train: &[&Gap]) -> [(u16, u16); 16] {
    let mut hz = [(0u16, 0u16); 16];
    for g in train {
        let need = g.need();
        for j in 1..=MAX_PINGS {
            if need < j {
                break;
            }
            let k = hz_key(local_hw((g.t0 + EVERY_S * i64::from(j)) * 1000));
            hz[k].0 = hz[k].0.saturating_add(1);
            if need == j {
                hz[k].1 = hz[k].1.saturating_add(1);
            }
        }
    }
    hz
}

/// Everything the rules learn from `train`.
pub fn learn(train: &[&Gap]) -> Learned {
    let c = profile(train);
    let mut parts: [Vec<&Gap>; 8] = Default::default();
    for g in train {
        let (h, wd) = local_hw(g.t0 * 1000);
        parts[usize::from(wd < 5) * 4 + (h / 6) as usize].push(g);
    }
    let mut daypart = [u8::MAX; 8];
    for (i, p) in parts.iter().enumerate() {
        if !p.is_empty() {
            daypart[i] = best_k(p) as u8;
        }
    }
    Learned {
        sleep7: sleep_window(&c, SLEEP_HOURS),
        sleep6: sleep_window(&c, 6),
        sleep8: sleep_window(&c, 8),
        best_k: best_k(train),
        daypart,
        hz: hazards(train),
    }
}

/// The rule `id` stands for, with its base pings and the cap it runs
/// under live (hours; `None` for a count that is not whole hours). `sleep`
/// is the 7-hour window in force (his own setting, else learned).
pub fn rule_of(id: &str, l: &Learned, sleep: Sleep) -> Option<(Rule, u32, Option<u32>)> {
    let k6 = cap_k(6);
    Some(match id {
        "flat-6" => (Rule::Flat, k6, Some(6)),
        "flat-3" => (Rule::Flat, cap_k(3), Some(3)),
        "flat-4" => (Rule::Flat, cap_k(4), Some(4)),
        "flat-8" => (Rule::Flat, cap_k(8), Some(8)),
        "flat-12" => (Rule::Flat, cap_k(12), Some(12)),
        "flat-24" => (Rule::Flat, cap_k(24), Some(24)),
        "flat-tuned" => (Rule::Flat, l.best_k, None),
        "sleep-cut" => (Rule::SleepCut(sleep), k6, Some(6)),
        "sleep-cut-6w" => (Rule::SleepCut(l.sleep6), k6, Some(6)),
        "sleep-cut-8w" => (Rule::SleepCut(l.sleep8), k6, Some(6)),
        "sleep-cut-8h" => (Rule::SleepCut(sleep), cap_k(8), Some(8)),
        "sleep-extend-1" => (Rule::SleepExtend { sleep, after: 1 }, k6, Some(6)),
        "sleep-extend-3" => (Rule::SleepExtend { sleep, after: 3 }, k6, Some(6)),
        "hybrid" => (Rule::Hybrid(sleep), k6, Some(6)),
        "daypart" => (Rule::Daypart(l.daypart), k6, Some(6)),
        "expected-hit" => (
            Rule::ExpectedHit {
                rho_pct: 100,
                hz: l.hz,
            },
            k6,
            Some(6),
        ),
        "expected-hit-light" => (
            Rule::ExpectedHit {
                rho_pct: 20,
                hz: l.hz,
            },
            k6,
            Some(6),
        ),
        _ => return None,
    })
}

/// The live form of `id`: its static id, the rule, and the cap it runs
/// under (ms) — what [`crate::keep_warm::Policy::load`] puts in force.
/// An unknown id is [`super::DEFAULT_RULE`].
pub fn live(
    id: &str,
    sleep: Sleep,
    learned: Option<&Learned>,
    every_ms: i64,
) -> (&'static str, Rule, Option<i64>) {
    let l = learned.copied().unwrap_or_default();
    let sid = POLICIES
        .iter()
        .map(|(p, _)| *p)
        .find(|p| *p == id && selectable(p))
        .unwrap_or(super::DEFAULT_RULE);
    let (rule, base, hours) = rule_of(sid, &l, sleep).unwrap_or((Rule::Flat, cap_k(6), Some(6)));
    let cap = match hours {
        Some(h) => i64::from(h) * 3_600_000,
        None => i64::from(base) * every_ms,
    };
    (sid, rule, Some(cap))
}

/// One week of the walk-forward.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Week {
    pub start_ms: i64,
    pub end_ms: i64,
    pub train: usize,
    pub test: usize,
    pub sleep: Sleep,
}

/// One rule's line in the table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Line {
    pub id: String,
    pub name: String,
    pub selectable: bool,
    /// Per week, oldest first, as [`Scoreboard::weeks`].
    pub weeks: Vec<Score>,
    /// The last [`WINDOW_WEEKS`] weeks added up.
    pub window: Score,
}

/// The walk-forward over the `n` weeks ending at `now_s` (oldest first),
/// keeping only weeks with [`MIN_TRAIN`] earlier moments when `min_train`.
pub fn walk_forward(
    rows: &[Gap],
    now_s: i64,
    n: usize,
    min_train: usize,
    manual: Option<Sleep>,
) -> (Vec<Week>, Vec<Line>) {
    let mut weeks = Vec::new();
    let mut lines: Vec<Line> = POLICIES
        .iter()
        .map(|(id, name)| Line {
            id: (*id).to_string(),
            name: (*name).to_string(),
            selectable: selectable(id),
            weeks: Vec::new(),
            window: Score::default(),
        })
        .collect();
    for i in (0..n).rev() {
        let (a, b) = (now_s - (i as i64 + 1) * WEEK_S, now_s - i as i64 * WEEK_S);
        let train: Vec<&Gap> = rows.iter().filter(|g| g.t0 < a).collect();
        if train.len() < min_train {
            continue;
        }
        let test: Vec<&Gap> = rows.iter().filter(|g| a <= g.t0 && g.t0 < b).collect();
        let l = learn(&train);
        let sleep = manual.unwrap_or(l.sleep7);
        weeks.push(Week {
            start_ms: a * 1000,
            end_ms: b * 1000,
            train: train.len(),
            test: test.len(),
            sleep,
        });
        for line in lines.iter_mut() {
            let ks: Vec<u32> = if line.id == FORESIGHT {
                test.iter().map(|g| oracle(g)).collect()
            } else {
                let (rule, base, _) =
                    rule_of(&line.id, &l, sleep).unwrap_or((Rule::Flat, cap_k(6), None));
                test.iter()
                    .map(|g| rule.pings(at_of(g), base, EVERY_S * 1000, &local_hw))
                    .collect()
            };
            line.weeks.push(score(&test, &ks));
        }
    }
    for line in lines.iter_mut() {
        let from = line.weeks.len().saturating_sub(WINDOW_WEEKS);
        let mut w = Score::default();
        for s in &line.weeks[from..] {
            w.add(s);
        }
        line.window = w;
    }
    (weeks, lines)
}

/// Another rule beating the active one (his ask: "if anything overtakes
/// that first option … we know about it").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Overtake {
    /// `<date>-<challenger>`, for `bin/holdcheck.py`'s seen list.
    pub id: String,
    pub active: String,
    pub challenger: String,
    pub active_usd: f64,
    pub challenger_usd: f64,
    pub weeks: usize,
}

/// The scoreboard's whole result, as [`super::SCOREBOARD_FILE`] holds it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Scoreboard {
    pub computed_ms: i64,
    /// Idle moments read, all time.
    pub moments: usize,
    pub weeks: Vec<Week>,
    pub table: Vec<Line>,
    /// The rule in force when it ran.
    pub active: String,
    /// The best selectable rule over the window (the active one when it leads).
    pub leader: String,
    /// His sleep learned on all data (the quietest 7 h).
    pub learned_sleep: Sleep,
    /// Every rule's parameters learned on all data: what runs live.
    pub learned: Learned,
    pub overtake: Option<Overtake>,
    /// The overtake was not in the previous run (a line was written).
    pub overtake_new: bool,
}

fn date_of(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// Score every rule on `rows` at `now_ms` for the active rule `active`.
pub fn scoreboard(
    rows: &[Gap],
    now_ms: i64,
    active: &str,
    manual: Option<Sleep>,
    prev: Option<&Scoreboard>,
) -> Scoreboard {
    let now_s = now_ms / 1000;
    let first = rows.iter().map(|g| g.t0).min().unwrap_or(now_s);
    let n = (((now_s - first) / WEEK_S) as usize).max(1);
    let (weeks, table) = walk_forward(rows, now_s, n, MIN_TRAIN, manual);
    let all: Vec<&Gap> = rows.iter().collect();
    let learned = learn(&all);
    let pick = |pred: &dyn Fn(&Line) -> bool| {
        table
            .iter()
            .filter(|l| pred(l))
            .max_by(|a, b| a.window.half.total_cmp(&b.window.half))
            .map(|l| l.id.clone())
    };
    let leader = pick(&|l| l.selectable).unwrap_or_else(|| active.to_string());
    let overtake = overtake(&table, active, weeks.len(), now_ms);
    let overtake_new = overtake.as_ref().is_some_and(|o| {
        prev.and_then(|p| p.overtake.as_ref())
            .is_none_or(|p| p.active != o.active || p.challenger != o.challenger)
    });
    Scoreboard {
        computed_ms: now_ms,
        moments: rows.len(),
        weeks,
        table,
        active: active.to_string(),
        leader,
        learned_sleep: learned.sleep7,
        learned,
        overtake,
        overtake_new,
    }
}

/// The best selectable rule beating `active` over the window, if one
/// does: higher summed over the window and higher in each of the last
/// [`OVERTAKE_WEEKS`] weeks. Needs [`OVERTAKE_WEEKS`] weeks or more.
pub fn overtake(table: &[Line], active: &str, n_weeks: usize, now_ms: i64) -> Option<Overtake> {
    if n_weeks < OVERTAKE_WEEKS {
        return None;
    }
    let a = table.iter().find(|l| l.id == active)?;
    let last = |l: &Line, i: usize| l.weeks[l.weeks.len() - 1 - i].half;
    let best = table
        .iter()
        .filter(|l| l.selectable && l.id != active)
        .filter(|l| l.window.half > a.window.half)
        .filter(|l| (0..OVERTAKE_WEEKS).all(|i| last(l, i) > last(a, i)))
        .max_by(|x, y| x.window.half.total_cmp(&y.window.half))?;
    Some(Overtake {
        id: format!("{}-{}", date_of(now_ms), best.id),
        active: active.to_string(),
        challenger: best.id.clone(),
        active_usd: a.window.half,
        challenger_usd: best.window.half,
        weeks: n_weeks.min(WINDOW_WEEKS),
    })
}
