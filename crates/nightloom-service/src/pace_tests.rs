use super::*;

const H: i64 = HOUR_MS;
/// 1970-01-05, a Monday, 00:00 UTC.
const MON: i64 = 4 * 24 * H;
const DAY: i64 = 24 * H;

fn pt(t: i64, p: f64) -> Pt {
    Pt { t, p, reset: None }
}

#[test]
fn the_slot_is_the_hour_of_the_week_from_monday_in_local_time() {
    let t = Table::new(0);
    assert_eq!(t.slot(MON), 0);
    assert_eq!(t.slot(MON + 9 * H + 30 * MIN_MS), 9);
    assert_eq!(t.slot(MON + DAY + H), 25);
    assert_eq!(t.slot(MON - H), 167, "Sunday 23:00");
    // Two hours east: Monday 00:00 UTC is 02:00 there.
    assert_eq!(Table::new(7200).slot(MON), 2);
}

#[test]
fn a_rise_is_spread_over_the_hours_it_spans() {
    let mut t = Table::new(0);
    t.add_pair(
        pt(MON + 9 * H + 30 * MIN_MS, 10.0),
        pt(MON + 10 * H + 30 * MIN_MS, 20.0),
        Kind::FiveHour,
    );
    assert!((t.pts[9] - 5.0).abs() < 1e-9 && (t.pts[10] - 5.0).abs() < 1e-9);
    assert!((t.hours() - 1.0).abs() < 1e-9);
    // A gap past the window's length is not spread at all.
    t.add_pair(pt(MON, 0.0), pt(MON + 6 * H, 50.0), Kind::FiveHour);
    assert!((t.hours() - 1.0).abs() < 1e-9);
}

#[test]
fn windows_split_where_the_figure_drops_or_the_reset_moves() {
    let s = vec![
        pt(0, 10.0),
        pt(H, 30.0),
        pt(2 * H, 5.0), // dropped: a new window
        Pt {
            t: 3 * H,
            p: 6.0,
            reset: Some(7 * H),
        },
        Pt {
            t: 4 * H,
            p: 7.0,
            reset: Some(9 * H),
        }, // reset moved
        pt(4 * H + 10 * MIN_MS, 7.5),
        pt(10 * H, 8.0), // past five hours from the window's first
    ];
    let w = windows(&s, Kind::FiveHour);
    assert_eq!(w.iter().map(Vec::len).collect::<Vec<_>>(), vec![2, 2, 2, 1]);
    // Small wobbles do not split.
    let w = windows(&[pt(0, 10.0), pt(H, 9.0)], Kind::FiveHour);
    assert_eq!(w.len(), 1);
}

#[test]
fn a_steady_rate_reaches_80_and_100_where_the_arithmetic_says() {
    let t = Table::new(0);
    // 20 points an hour from 40%: 80% in 2 h, 100% in 3 h.
    let pr = project(&t, MON, 40.0, MON + 5 * H, Some(20.0), Kind::FiveHour);
    // With an empty table the recent rate fades to zero, so it is slower:
    assert!(pr.at80.is_none() || pr.at80.unwrap() > MON + 2 * H);
    let mut table = Table::new(0);
    for d in 0..7 {
        for h in 0..24 {
            table.add_pair(
                pt(MON + d * DAY + h * H, 0.0),
                pt(MON + d * DAY + (h + 1) * H, 20.0),
                Kind::FiveHour,
            );
        }
    }
    let full = Tuning {
        slot_scale: 1.0,
        ..Tuning::of(Kind::FiveHour)
    };
    let pr = project_tuned(
        &table,
        MON,
        40.0,
        MON + 5 * H,
        Some(20.0),
        Kind::FiveHour,
        full,
    );
    let near = |a: Option<i64>, b: i64| a.is_some_and(|a| (a - b).abs() < 2 * MIN_MS);
    assert!(near(pr.at80, MON + 2 * H), "{pr:?}");
    assert!(near(pr.at100, MON + 3 * H), "{pr:?}");
    assert_eq!(pr.end_pct, 100.0);
    // Already past the line: now.
    let pr = project(&table, MON, 85.0, MON + H, None, Kind::FiveHour);
    assert_eq!(pr.at80, Some(MON));
}

/// A month of a working pattern: 9-11 AM on weekdays, 15 points an hour
/// on the five-hour window, nothing else; readings every 5 minutes while
/// the app is open (8 AM to 1 PM).
fn morning_worker(days: i64) -> Vec<Logged> {
    let mut out = Vec::new();
    for d in 0..days {
        let day = MON + d * DAY;
        let weekday = d % 7 < 5;
        let reset_at = day + 13 * H; // a window 8 AM - 1 PM
        let mut p = 0.0;
        let mut t = day + 8 * H;
        while t <= day + 13 * H - 5 * MIN_MS {
            if weekday && t > day + 9 * H && t <= day + 11 * H {
                p += 15.0 * 5.0 / 60.0;
            }
            out.push(Logged {
                t,
                fh: Some(p),
                fr: Some(reset_at / 1000),
                sd: None,
                sr: None,
            });
            t += 5 * MIN_MS;
        }
    }
    out
}

#[test]
fn the_forecast_learns_the_hours_he_works_and_beats_the_straight_line() {
    let log = morning_worker(28);
    let s = series(&log, Kind::FiveHour);
    let wins = windows(&s, Kind::FiveHour);
    assert_eq!(wins.len(), 28);
    let bt = backtest(&wins, Kind::FiveHour, 0);
    assert!(bt.checks >= 20, "{bt:?}");
    let (m, l) = (bt.err_pts.unwrap(), bt.linear_err_pts.unwrap());
    assert!(m < l, "model {m:.2} vs line {l:.2}");

    // At 8:30 AM on a Monday with nothing used yet, the line says nothing
    // will happen; the history says 30 points by 11 AM.
    let mut table = Table::new(0);
    for w in &wins {
        for p in w.windows(2) {
            table.add_pair(p[0], p[1], Kind::FiveHour);
        }
    }
    let now = MON + 28 * DAY + 8 * H + 30 * MIN_MS;
    let pr = project(&table, now, 0.0, now + 3 * H, Some(0.0), Kind::FiveHour);
    // Half weight on the table (`Tuning::of`): ~15 of the 30.
    assert!(pr.end_pct > 8.0 && pr.end_pct < 35.0, "{pr:?}");
}

#[test]
fn the_pace_is_not_ready_until_enough_past_checks_and_drops_a_passed_reset() {
    let log = morning_worker(2);
    let now = log.last().unwrap().t;
    let p = pace_of(&log, now, 0);
    let fh = p.five_hour.unwrap();
    assert!(!fh.ready);
    assert!(p.seven_day.is_none());
    // Past the reading's own reset: nothing to say about the window now.
    let later = pace_of(&log, now + 2 * H, 0);
    assert!(later.five_hour.is_none());

    let log = morning_worker(28);
    let now = log.last().unwrap().t;
    let fh = pace_of(&log, now, 0).five_hour.unwrap();
    assert!(fh.ready, "{fh:?}");
    assert_eq!(fh.horizon_hours, 1.0);
}

#[test]
fn a_reading_is_logged_when_it_changes_or_ten_minutes_pass() {
    let a = Logged {
        t: 1_000,
        fh: Some(10.0),
        fr: None,
        sd: Some(5.0),
        sr: None,
    };
    assert!(worth_logging(None, &a));
    let same = Logged { t: 2_000, ..a };
    assert!(!worth_logging(Some(&a), &same));
    let older = Logged {
        t: 500,
        fh: Some(11.0),
        ..a
    };
    assert!(!worth_logging(Some(&a), &older));
    assert!(worth_logging(
        Some(&a),
        &Logged {
            fh: Some(11.0),
            ..same
        }
    ));
    assert!(worth_logging(
        Some(&a),
        &Logged {
            t: 1_000 + 10 * MIN_MS,
            ..a
        }
    ));
}

#[test]
fn a_new_log_is_seeded_from_the_claude_app_and_every_chats_reply_readings() {
    let d = std::env::temp_dir().join(format!("nl-pace-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    struct D(std::path::PathBuf);
    impl D {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for D {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let d = D(d);
    let ask = d.path().join("projects/p1/sessions/ask/chat1");
    std::fs::create_dir_all(&ask).unwrap();
    std::fs::write(
        ask.join(crate::turn_usage::LINES_FILE),
        r#"{"target":1,"started_at_ms":100,"ended_at_ms":200,"five_hour":{"start":3.0,"end":4.0},"seven_day":{"start":27.0,"end":27.0},"shared":false,"cost_usd":0.5,"start_at_ms":150,"end_at_ms":250}
not json
"#,
    )
    .unwrap();
    let unfiled = d.path().join("unfiled/sessions/ask/chat2");
    std::fs::create_dir_all(&unfiled).unwrap();
    std::fs::write(
        unfiled.join(crate::turn_usage::LINES_FILE),
        r#"{"target":1,"started_at_ms":1,"ended_at_ms":2,"five_hour":null,"seven_day":null,"shared":false,"cost_usd":null,"start_at_ms":10,"end_at_ms":20}
"#,
    )
    .unwrap();
    let desk = d.path().join("desk.json");
    std::fs::write(
        &desk,
        r#"{"version":1,"samples":[{"t":50,"org":"x","u":{"fh":2,"sd":20,"xu":0}}]}"#,
    )
    .unwrap();

    let mut last = None;
    let r = Logged {
        t: 300,
        fh: Some(5.0),
        fr: Some(9),
        sd: Some(28.0),
        sr: None,
    };
    record_in(d.path(), Some(&desk), &mut last, r);
    let log = read_log_in(d.path());
    assert_eq!(
        log.iter().map(|l| l.t).collect::<Vec<_>>(),
        vec![50, 150, 250, 300]
    );
    assert_eq!(log[1].fh, Some(3.0));
    assert_eq!(log[2].fh, Some(4.0));
    assert_eq!(last, Some(r));

    // The next run reads the last line rather than seeding again.
    let mut last = None;
    record_in(d.path(), Some(&desk), &mut last, Logged { t: 400, ..r });
    assert_eq!(
        read_log_in(d.path()).len(),
        4,
        "same figures within ten minutes"
    );
    // The import file is merged in.
    std::fs::write(d.path().join(IMPORT_FILE), "{\"t\":40,\"fh\":1.0}\n").unwrap();
    assert_eq!(read_log_in(d.path())[0].t, 40);
}

/// By hand, read-only (item 769's measurement): the pace from his own
/// history as a new log would be seeded, plus the log and import if
/// present. Run it ignored, with `NL_PACE_DIR` set to `~/.nightloom`,
/// `--nocapture`, and the keychain skip.
#[test]
#[ignore]
fn measure_on_real_history() {
    let dir = std::path::PathBuf::from(std::env::var("NL_PACE_DIR").expect("NL_PACE_DIR"));
    let home = std::env::var("HOME").unwrap();
    let desk = Path::new(&home).join(crate::plan_usage::DESKTOP_SAMPLE);
    let mut log = seed_in(&dir, Some(&desk));
    log.extend(read_log_in(&dir));
    log.sort_by_key(|l| l.t);
    log.dedup_by_key(|l| l.t);
    let tz = local_offset_secs();
    for kind in [Kind::FiveHour, Kind::Week] {
        let s = series(&log, kind);
        let wins = windows(&s, kind);
        let bt = backtest(&wins[..wins.len().saturating_sub(1)], kind, tz);
        let closed = &wins[..wins.len().saturating_sub(1)];
        let base = Tuning::of(kind);
        for (label, t) in [
            ("shipped", base),
            ("slots only", Tuning { fade_ms: 1, ..base }),
            (
                "recent only",
                Tuning {
                    slot_scale: 0.0,
                    fade_ms: i64::MAX / 4,
                    ..base
                },
            ),
            (
                "fade x0.5",
                Tuning {
                    fade_ms: base.fade_ms / 2,
                    ..base
                },
            ),
            (
                "fade x2",
                Tuning {
                    fade_ms: base.fade_ms * 2,
                    ..base
                },
            ),
            (
                "recent x2",
                Tuning {
                    recent_ms: base.recent_ms * 2,
                    ..base
                },
            ),
            (
                "recent x4",
                Tuning {
                    recent_ms: base.recent_ms * 4,
                    ..base
                },
            ),
            (
                "slots x0.5",
                Tuning {
                    slot_scale: 0.5,
                    ..base
                },
            ),
            (
                "slots x0.25",
                Tuning {
                    slot_scale: 0.25,
                    ..base
                },
            ),
            (
                "slots x0.35",
                Tuning {
                    slot_scale: 0.35,
                    ..base
                },
            ),
            (
                "slots x0.7",
                Tuning {
                    slot_scale: 0.7,
                    ..base
                },
            ),
            (
                "slots x0.5 recent x2",
                Tuning {
                    slot_scale: 0.5,
                    recent_ms: base.recent_ms * 2,
                    ..base
                },
            ),
        ] {
            let (b, flat) = backtest_tuned(closed, kind, tz, t);
            println!(
                "  {label}: model {:.2} line {:.2} flat {:.2} n {}",
                b.err_pts.unwrap_or(0.0),
                b.linear_err_pts.unwrap_or(0.0),
                flat.unwrap_or(0.0),
                b.checks
            );
        }
        println!(
            "{}: {} readings, {} windows, first {} last {}; backtest {:?}",
            kind.name(),
            s.len(),
            wins.len(),
            s.first().map_or(0, |p| p.t),
            s.last().map_or(0, |p| p.t),
            bt
        );
    }
    let now = log.last().map_or(0, |l| l.t);
    println!("{:#?}", pace_of(&log, now, tz));
}
