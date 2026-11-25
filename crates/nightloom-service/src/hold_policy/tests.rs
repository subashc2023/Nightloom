use super::gaps::{Gap, gaps_of};
use super::sim::{self, cap_k, money, oracle, overtake, score};
use super::*;
use crate::keep_warm::{Mode, Policy, Reply, Step, Why, step, warm_until};
use chrono::{Local, TimeZone};

const H: i64 = 3_600_000;
const EVERY: i64 = 55 * 60_000;

/// Unix ms of a local wall-clock time on 2026-11-18 (a Wednesday) + `day` days.
fn at(day: u32, h: u32, m: u32) -> i64 {
    Local
        .with_ymd_and_hms(2026, 11, 18 + day, h, m, 0)
        .single()
        .expect("a local time")
        .timestamp_millis()
}

fn reply(sent_ms: i64) -> Reply {
    Reply {
        sent_ms,
        context: 120_000,
        one_hour: true,
    }
}

fn sleep_policy(hours: i64) -> Policy {
    Policy {
        cap_ms: hours * H,
        rule: Rule::SleepCut(DEFAULT_SLEEP),
        rule_id: "sleep-cut-8h",
        sleep: Some(DEFAULT_SLEEP),
        ..Policy::default()
    }
}

#[test]
fn a_window_that_wraps_midnight_contains_both_sides() {
    let s = Sleep { start: 23, end: 6 };
    assert!(s.contains(23) && s.contains(0) && s.contains(5));
    assert!(!s.contains(6) && !s.contains(22));
    let d = DEFAULT_SLEEP;
    assert!(d.contains(2) && d.contains(8) && !d.contains(9) && !d.contains(1));
}

#[test]
fn the_quietest_seven_hours_are_his_sleep() {
    let mut c = [10u32; 24];
    c[2..9].fill(0);
    assert_eq!(sleep_window(&c, 7), Sleep { start: 2, end: 9 });
    // A tie keeps the first start, as Python's min does.
    assert_eq!(sleep_window(&[0; 24], 7), Sleep { start: 0, end: 7 });
}

#[test]
fn sleep_cut_stops_at_the_first_ping_in_his_sleep() {
    let r = SleepCut8();
    // A reply at 11 PM: pings at 11:55, 12:50, 1:45; 2:40 AM is asleep.
    let a = At {
        t0_ms: at(0, 23, 0),
        ctx: 100_000,
        fable: false,
    };
    assert_eq!(r.pings(a, cap_k(8), EVERY, &local_hw), 3);
    // A reply at 3 AM, in his sleep: nothing.
    let a = At {
        t0_ms: at(1, 3, 0),
        ctx: 100_000,
        fable: false,
    };
    assert_eq!(r.pings(a, cap_k(8), EVERY, &local_hw), 0);
    // A reply at 10 AM: the whole 8 h.
    let a = At {
        t0_ms: at(1, 10, 0),
        ctx: 100_000,
        fable: false,
    };
    assert_eq!(r.pings(a, cap_k(8), EVERY, &local_hw), 8);
}

#[allow(non_snake_case)]
fn SleepCut8() -> Rule {
    Rule::SleepCut(DEFAULT_SLEEP)
}

#[test]
fn the_schedule_sends_no_ping_in_his_sleep_and_says_why() {
    let p = sleep_policy(8);
    let r = reply(at(0, 23, 0));
    // The third ping (1:45 AM) is still due.
    let third = r.sent_ms + 3 * EVERY;
    assert_eq!(
        step(
            Mode::On,
            Some(&r),
            Some(third - EVERY),
            false,
            false,
            &p,
            third - 1
        ),
        Step::Wait(third)
    );
    // After it, the next would be 2:40 AM: idle, for his sleep.
    assert_eq!(
        step(
            Mode::On,
            Some(&r),
            Some(third),
            false,
            false,
            &p,
            third + 10
        ),
        Step::Idle(Why::Sleep)
    );
    // The cache stays warm to the third ping's hour, and the chip is told.
    assert_eq!(warm_until(&r, None, true, &p), third + H);
    assert!(crate::keep_warm::cut_by_sleep(&r, None, &p));
    // "Until I'm back" runs through his sleep.
    assert_eq!(
        step(
            Mode::Once,
            Some(&r),
            Some(third),
            false,
            false,
            &p,
            third + 10
        ),
        Step::Wait(third + EVERY)
    );
}

#[test]
fn an_aside_that_moves_a_ping_into_his_sleep_stops_it() {
    let p = sleep_policy(8);
    let r = reply(at(0, 23, 0));
    // An aside at 1:30 AM read the cache: the next ping would be 2:25 AM.
    let aside = at(1, 1, 30);
    assert_eq!(
        step(
            Mode::On,
            Some(&r),
            Some(aside),
            false,
            false,
            &p,
            aside + 10
        ),
        Step::Idle(Why::Sleep)
    );
}

#[test]
fn awake_the_sleep_rule_holds_the_whole_eight_hours() {
    let p = sleep_policy(8);
    let r = reply(at(1, 10, 0));
    assert_eq!(warm_until(&r, None, true, &p), r.sent_ms + 8 * EVERY + H);
    assert!(!crate::keep_warm::cut_by_sleep(&r, None, &p));
    let last = r.sent_ms + 8 * EVERY;
    assert_eq!(
        step(Mode::On, Some(&r), Some(last), false, false, &p, last + 10),
        Step::Idle(Why::Cap)
    );
}

#[test]
fn the_flat_default_schedule_is_item_541s() {
    let p = Policy::default();
    let r = reply(at(0, 23, 0));
    // Six pings run through the night under the flat cap.
    assert_eq!(warm_until(&r, None, true, &p), r.sent_ms + 6 * EVERY + H);
    let sixth = r.sent_ms + 6 * EVERY;
    assert_eq!(
        step(
            Mode::On,
            Some(&r),
            Some(sixth),
            false,
            false,
            &p,
            sixth + 10
        ),
        Step::Idle(Why::Cap)
    );
}

fn gap(t0_ms: i64, gap_min: f64, ctx: u64) -> Gap {
    Gap {
        t0: t0_ms / 1000,
        gap_min,
        censored: false,
        ctx,
        fable: false,
    }
}

#[test]
fn money_matches_items_541_and_579() {
    // 200k context, back after 3 h: needs ceil(120/55) = 3 pings.
    let g = gap(at(1, 12, 0), 180.0, 200_000);
    assert_eq!(g.need(), 3);
    let (net, read, other, save) = money(&g, 3);
    assert!((read - 3.0 * 200_000.0 * 0.2 / 1e6).abs() < 1e-12);
    assert!((other - 3.0 * (300.0 * 8.0 + 100.0 * 20.0) / 1e6).abs() < 1e-12);
    assert!((save - 200_000.0 * 7.8 / 1e6).abs() < 1e-12);
    assert!((net - (save - read - other)).abs() < 1e-12);
    assert_eq!(money(&g, 2).3, 0.0);
    assert_eq!(oracle(&g), 3);
    let s = score(&[&g], &[3]);
    assert_eq!((s.avoided, s.pings), (1, 3));
    assert!((s.half - (save - other - 0.5 * read)).abs() < 1e-12);
}

#[test]
fn a_return_before_the_cap_is_charged_only_the_pings_it_needed() {
    // Item 961: back after 2 of 8 allowed pings (gap 160 min needs ceil(100/55) = 2); pinging stopped there.
    let g = gap(at(1, 12, 0), 160.0, 200_000);
    assert_eq!(g.need(), 2);
    assert_eq!(money(&g, 8), money(&g, 2));
    let (_, read, other, save) = money(&g, 8);
    assert!((read - 2.0 * 200_000.0 * 0.2 / 1e6).abs() < 1e-12);
    assert!((other - 2.0 * (300.0 * 8.0 + 100.0 * 20.0) / 1e6).abs() < 1e-12);
    assert!(save > 0.0);
    assert_eq!(score(&[&g], &[8]).pings, 2);
    // A gap he never came back to still pays for every ping allowed.
    let mut never = gap(at(1, 12, 0), 600.0, 200_000);
    never.censored = true;
    assert_eq!(score(&[&never], &[8]).pings, 8);
}

#[test]
fn gaps_are_the_idle_hours_between_requests() {
    let t = 1_764_000_000.0;
    let reqs = [
        (t, 100, false),
        (t + 30.0 * 60.0, 120, false),
        (t + 30.0 * 60.0 + 3.0 * 3600.0, 150, true),
    ];
    let gs = gaps_of(&reqs, 0, t as i64 + 10 * 3600);
    // Only the 3-hour gap, and the last one running to now (censored).
    assert_eq!(gs.len(), 2);
    assert_eq!(
        (gs[0].ctx, gs[0].gap_min, gs[0].censored),
        (120, 180.0, false)
    );
    assert!(gs[1].censored && gs[1].fable);
}

#[test]
fn a_rule_that_wins_two_weeks_running_overtakes_the_active_one() {
    let mk = |id: &str, w: [f64; 3]| sim::Line {
        id: id.into(),
        name: id.into(),
        selectable: sim::selectable(id),
        weeks: w
            .iter()
            .map(|&h| sim::Score {
                half: h,
                ..Default::default()
            })
            .collect(),
        window: sim::Score {
            half: w.iter().sum(),
            ..Default::default()
        },
    };
    let table = vec![
        mk("sleep-cut-8h", [10.0, 10.0, 10.0]),
        mk("flat-8", [9.0, 11.0, 11.0]),
        mk("foresight", [50.0, 50.0, 50.0]),
    ];
    let o = overtake(&table, "sleep-cut-8h", 3, at(0, 12, 0)).expect("an overtake");
    assert_eq!(o.challenger, "flat-8");
    // Ahead in total but not in both last weeks: no overtake.
    let table = vec![
        mk("sleep-cut-8h", [10.0, 10.0, 10.0]),
        mk("flat-8", [30.0, 9.0, 11.0]),
    ];
    assert!(overtake(&table, "sleep-cut-8h", 3, 0).is_none());
    // One week is too few.
    assert!(overtake(&table, "sleep-cut-8h", 1, 0).is_none());
}

#[test]
fn the_active_rule_defaults_to_the_sleep_cut_and_switches_only_by_hand() {
    let d = std::env::temp_dir().join(format!("nl-878-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    let (id, rule, cap) = active_rule(Some(&d), EVERY);
    assert_eq!(
        (id, rule, cap),
        ("sleep-cut-8h", Rule::SleepCut(DEFAULT_SLEEP), Some(8 * H))
    );
    assert!(set_active(&d, "foresight", 1).is_err());
    set_active(&d, "flat-6", 1).unwrap();
    assert_eq!(
        active_rule(Some(&d), EVERY),
        ("flat-6", Rule::Flat, Some(6 * H))
    );
    set_manual_sleep(&d, Some(Sleep { start: 1, end: 7 })).unwrap();
    set_active(&d, "sleep-cut", 2).unwrap();
    assert_eq!(
        active_rule(Some(&d), EVERY).1,
        Rule::SleepCut(Sleep { start: 1, end: 7 })
    );
    set_manual_sleep(&d, None).unwrap();
    assert_eq!(
        active_rule(Some(&d), EVERY).1,
        Rule::SleepCut(DEFAULT_SLEEP)
    );
    let p = Policy::load(Some(&d));
    assert_eq!((p.rule_id, p.cap_ms), ("sleep-cut", 6 * H));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn the_scoreboard_scores_every_rule_and_writes_an_overtake_once() {
    // Four weeks of a made-up life: replies through the day, returns
    // after 2 h by day and the next morning by night, and one chat a day
    // he never comes back to (since item 961 a rule pays only for the
    // pings before his return, so only these make 24 h holds waste).
    let mut rows = Vec::new();
    for d in 0..35u32 {
        let day = |h| {
            Local
                .with_ymd_and_hms(2026, 10, 10, h, 0, 0)
                .single()
                .unwrap()
                .timestamp_millis()
                + i64::from(d) * 86_400_000
        };
        for h in [10, 14, 18, 22] {
            let back = if h == 22 { 11.0 * 60.0 } else { 130.0 };
            rows.push(gap(day(h), back, 150_000));
        }
        let mut never = gap(day(16), 20.0 * 60.0, 150_000);
        never.censored = true;
        rows.push(never);
    }
    rows.sort_by_key(|g| g.t0);
    let now = rows.last().unwrap().t0 * 1000 + 12 * H;
    let b = sim::scoreboard(&rows, now, "flat-24", None, None);
    assert_eq!(b.table.len(), sim::POLICIES.len());
    assert!(b.weeks.len() >= 3);
    // His sleep is learned where nothing happens.
    assert!(b.learned_sleep.contains(3));
    // Flat 24 h pings the never-back chat all day and night: something
    // beats it, once.
    let o = b.overtake.clone().expect("an overtake");
    assert!(b.overtake_new && o.challenger_usd > o.active_usd);
    let again = sim::scoreboard(&rows, now, "flat-24", None, Some(&b));
    assert!(again.overtake.is_some() && !again.overtake_new);
    // The ceiling is the best line and never the leader.
    let fore = b.table.iter().find(|l| l.id == sim::FORESIGHT).unwrap();
    assert!(
        b.table
            .iter()
            .all(|l| l.window.half <= fore.window.half + 1e-9)
    );
    assert_ne!(b.leader, sim::FORESIGHT);
}

#[test]
fn an_idle_moment_copied_into_a_later_session_counts_once() {
    // Item 970: the same gap under two Claude Code sessions (a resume
    // carries the history), plus a different gap at the same moment.
    let a = gap(at(1, 12, 0), 180.0, 200_000);
    let copy = gap(at(1, 12, 0), 180.0, 200_000);
    let other = gap(at(1, 12, 0), 90.0, 200_000);
    let rows = super::gaps::dedupe(vec![a, copy, other]);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].gap_min, 180.0);
    assert_eq!(rows[1].gap_min, 90.0);
}
