//! The built-in task suite.
//!
//! Every task here obeys two rules. Its answer cannot be known in advance —
//! the facts are invented, so a model that guesses is wrong and a model that
//! reads is right. And its check is mechanical, so a pass is a fact about what
//! happened rather than a judgement about the prose.
//!
//! They are small on purpose. A task that takes forty tool calls tells you
//! that something went wrong somewhere; a task that takes three tells you
//! where.
//!
//! # The three shape tasks
//!
//! `one-call`, `three-sequential` and `three-parallel` ask a different
//! question from the rest: not *can it finish the job*, but *can it make this
//! shape of tool call*. One call where one will do, a chain of three where
//! each depends on the last, and three at once where they are independent.
//!
//! Two things follow from that. The instruction **names the shape** rather
//! than leaving the model to pick one — a shape task where the model chooses
//! the shape is measuring taste, and there is nothing to compare across
//! models. And the verdict comes partly from the trace rather than entirely
//! from the disk, because three files read in one batch and three read one
//! after another leave a workspace that is identical in every byte.
//!
//! They are also the closest thing here to a harness test. An adapter that
//! surfaced only the first of three buffered tool calls, or an engine that
//! dropped the tail of a round, would fail `three-parallel` while streaming
//! flawlessly under `probe`.

use crate::task::Task;
use std::path::Path;

/// Every task, in rough order of difficulty.
pub const SUITE: &[Task] = &[
    ONE_CALL,
    FIND_FACT,
    THREE_SEQUENTIAL,
    THREE_PARALLEL,
    FIX_VALUE,
    RENAME_ACROSS_FILES,
    ABSENT_FILE,
];

pub fn by_name(name: &str) -> Option<&'static Task> {
    SUITE.iter().find(|t| t.name == name)
}

/// Can it find one fact in a tree it has to search?
///
/// The fact sits in neither the obviously-named file nor the top level, so
/// listing the root is not enough — something has to grep or glob.
const FIND_FACT: Task = Task {
    name: "find-fact",
    instruction: "What is the calibration offset for the west array? Answer with just the number.",
    files: &[
        ("README.md", "# Site config\n\nSee the notes directory.\n"),
        (
            "notes/east.md",
            "East array\n\ncalibration offset: 11.2\nlast serviced: March\n",
        ),
        (
            "notes/west.md",
            "West array\n\ncalibration offset: 48.6\nlast serviced: never\n",
        ),
        (
            "notes/decommissioned/west-old.md",
            "calibration offset: 3.1\n",
        ),
    ],
    check: |o| {
        let answer = o.answer;
        if answer.contains("48.6") {
            return Ok(());
        }
        // The decommissioned file is the trap: same phrase, wrong array.
        if answer.contains("3.1") {
            return Err("answered from notes/decommissioned/west-old.md".into());
        }
        Err(format!("expected 48.6, got: {}", one_line(answer)))
    },
};

/// Can it edit one value in place without rewriting the file?
///
/// The check insists the rest of the file survives, which is the failure that
/// actually happens: a model that regenerates a config from memory produces
/// something that looks right and has quietly lost three keys.
const FIX_VALUE: Task = Task {
    name: "fix-value",
    instruction: "The retry limit in config.toml should be 5, not 500. Fix it.",
    files: &[(
        "config.toml",
        "[server]\nhost = \"10.0.0.4\"\nport = 8443\n\n[client]\nretry_limit = 500\ntimeout_ms = 2500\nuser_agent = \"probe/1.4\"\n",
    )],
    check: |o| {
        let dir = o.dir;
        let text = read(dir, "config.toml")?;
        if !text.contains("retry_limit = 5\n") {
            return Err("retry_limit was not set to 5".into());
        }
        for kept in ["10.0.0.4", "8443", "timeout_ms = 2500", "probe/1.4"] {
            if !text.contains(kept) {
                return Err(format!("rewrote the file and lost {kept:?}"));
            }
        }
        Ok(())
    },
};

/// Can it change one thing in every place it appears?
///
/// Three files, one of which mentions the old name twice, and a fourth that
/// contains a similar-looking name it must leave alone.
const RENAME_ACROSS_FILES: Task = Task {
    name: "rename-across-files",
    instruction: "Rename the function `fetch_rows` to `load_rows` everywhere it is used.",
    files: &[
        (
            "src/db.py",
            "def fetch_rows(q):\n    return run(q)\n\ndef count():\n    return len(fetch_rows('all'))\n",
        ),
        (
            "src/report.py",
            "from db import fetch_rows\n\nrows = fetch_rows('today')\n",
        ),
        ("src/cache.py", "# fetch_rows is memoized upstream\n"),
        // Must survive: a different function whose name contains the old one.
        ("src/legacy.py", "def fetch_rows_v1(q):\n    return None\n"),
    ],
    check: |o| {
        let dir = o.dir;
        for file in ["src/db.py", "src/report.py", "src/cache.py"] {
            let text = read(dir, file)?;
            if text.contains("fetch_rows") && !text.contains("fetch_rows_v1") {
                return Err(format!("{file} still mentions fetch_rows"));
            }
            if !text.contains("load_rows") {
                return Err(format!("{file} was not updated"));
            }
        }
        let legacy = read(dir, "src/legacy.py")?;
        if !legacy.contains("fetch_rows_v1") {
            return Err("renamed fetch_rows_v1, which is a different function".into());
        }
        Ok(())
    },
};

/// Does it say so when the thing is not there?
///
/// The failure this catches is the expensive one: inventing plausible content
/// for a file that does not exist, or creating the file to make the request
/// true. Both look like success in a transcript.
const ABSENT_FILE: Task = Task {
    name: "absent-file",
    instruction: "What port is configured in deploy/production.yaml?",
    files: &[
        ("deploy/staging.yaml", "port: 8080\nreplicas: 1\n"),
        ("README.md", "# Deploys\n"),
    ],
    check: |o| {
        let (dir, answer) = (o.dir, o.answer);
        if dir.join("deploy/production.yaml").exists() {
            return Err("created the file rather than reporting it missing".into());
        }
        let lower = normalize(answer);
        // The weakest of the four checks, and deliberately generous. Most of
        // the weight is carried by the two facts above and below — the file
        // was not created, and staging's port was not passed off as
        // production's — which are unambiguous. Whether prose "says missing"
        // is not, and a tight phrase list would fail correct answers for
        // wording, which is a worse error in an eval than letting one
        // through: a false failure sends someone hunting a bug that is not
        // there. So: any negation at all, anywhere in the reply.
        let negated = [
            "no ", "not ", "n't", "missing", "absent", "unable", "cannot", "can not",
        ]
        .iter()
        .any(|p| lower.contains(p));
        if !negated {
            return Err(format!(
                "did not report the file missing: {}",
                one_line(answer)
            ));
        }
        // 8080 is staging's. Reporting it as production's is the confabulation
        // this task exists to catch, even alongside a note that the file is
        // absent.
        if lower.contains("8080") && !lower.contains("staging") {
            return Err("reported staging's port as production's".into());
        }
        Ok(())
    },
};

/// Can it make one tool call when one is all the job needs?
///
/// The floor of the three shape tasks, and worth having as a task rather than
/// as an assumption: a model that cannot be talked out of listing the
/// directory first will burn a round on every turn of every session, and a
/// model that answers `signal_id` without opening anything has made the value
/// up — which is the same failure `absent-file` catches, arriving by a
/// different road.
const ONE_CALL: Task = Task {
    name: "one-call",
    instruction: "Read beacon.txt, in this directory, and tell me its signal_id. \
                  Answer with just the id. One tool call is enough — don't look around first.",
    files: &[
        (
            "beacon.txt",
            "station: NL-4\nsignal_id: HX-7729\nbattery: 0.62\n",
        ),
        ("notes.txt", "Beacons report every 90 seconds.\n"),
    ],
    check: |o| {
        if !o.answer.contains("HX-7729") {
            return Err(format!("expected HX-7729, got: {}", one_line(o.answer)));
        }
        match o.trace.total_calls() {
            1 => Ok(()),
            0 => Err("answered without opening the file".into()),
            n => Err(format!(
                "took {n} calls (shape {}) to read one file it was handed the name of",
                o.trace.shape()
            )),
        }
    },
};

/// Can it chain three calls, each one depending on the last?
///
/// The trail is the forcing function: nothing names `relay/2c/node.txt` except
/// `relay/7f/node.txt`, which nothing names except `start.txt`. So the three
/// reads have to land in three different rounds, in that order, and no amount
/// of listing or grepping shortens it — a glob finds all four relay codes and
/// cannot say which one the trail arrives at.
///
/// Extra rounds are fine. The check asks that the three reads happened in
/// increasing order, not that nothing else did: a model that lists the
/// directory first has done nothing wrong here, and failing it for that would
/// be measuring caution rather than chaining.
const THREE_SEQUENTIAL: Task = Task {
    name: "three-sequential",
    instruction: "Start at start.txt and follow each file's `next:` pointer to the file it \
                  names, until you reach one carrying a relay code. Take it one file at a \
                  time — don't read ahead. Report the relay code.",
    files: &[
        ("start.txt", "relay trail\n\nnext: relay/7f/node.txt\n"),
        ("relay/7f/node.txt", "next: relay/2c/node.txt\n"),
        ("relay/2c/node.txt", "relay code: QUARTZ-88\n"),
        // Off the trail, and findable by every shortcut: a listing shows them,
        // a glob matches them, and a grep for "relay code" returns all three
        // together. Only following the pointers says which one is the answer.
        ("relay/3d/node.txt", "relay code: BASALT-12\n"),
        ("relay/9b/node.txt", "relay code: OLIVINE-40\n"),
        ("relay/5e/node.txt", "next: relay/3d/node.txt\n"),
    ],
    check: |o| {
        for (code, node) in [("BASALT-12", "relay/3d"), ("OLIVINE-40", "relay/9b")] {
            if o.answer.contains(code) {
                return Err(format!(
                    "answered {code} from {node}, which is not on the trail"
                ));
            }
        }
        if !o.answer.contains("QUARTZ-88") {
            return Err(format!("expected QUARTZ-88, got: {}", one_line(o.answer)));
        }
        let step = |file: &'static str| o.trace.first_round_where(move |c| c.mentions(file));
        match (step("start.txt"), step("7f/node.txt"), step("2c/node.txt")) {
            (Some(a), Some(b), Some(c)) if a < b && b < c => Ok(()),
            (Some(_), Some(_), Some(_)) => Err(format!(
                "read the trail out of order or in one batch (shape {})",
                o.trace.shape()
            )),
            _ => Err(format!(
                "reached the answer without reading all three files on the trail (shape {})",
                o.trace.shape()
            )),
        }
    },
};

/// Can it issue three calls at once?
///
/// The one thing on the disk that cannot distinguish a pass from a failure:
/// three files read in one batch and three read one after another leave
/// exactly the same workspace. So this is checked against the trace, and it is
/// as much a test of the harness as of the model — an adapter that buffers
/// tool-call fragments and flushes only the first would fail here while
/// looking perfectly healthy under `probe`.
///
/// # Why the instruction never says "parallel tool calls"
///
/// It did, and it cost twenty rounds. Asked for "one batch of parallel tool
/// calls", gpt-5-mini issued exactly the three calls wanted and then said, in
/// its own reasoning summary: *"I initially used the read_file function
/// sequentially, while the user wanted all three requests in one batch through
/// parallel tool calls. I realize I should use `multi_tool_use.parallel`
/// instead."* It then reissued the identical batch twenty times over, hunting
/// a tool that does not exist on the request.
///
/// Two things in that are worth keeping. A model cannot see, from its own
/// replayed transcript, whether its calls went out together — so an
/// instruction it has no way to verify it followed is one it can loop on
/// forever. And `multi_tool_use.parallel` is an OpenAI-internal name that the
/// phrase itself summons. So the instruction describes the *situation* — these
/// three reads do not depend on each other — and lets the shape follow, which
/// is what the rest of the suite does anyway.
const THREE_PARALLEL: Task = Task {
    name: "three-parallel",
    instruction: "Read sensor/a.txt, sensor/b.txt and sensor/c.txt and tell me the sum of \
                  their readings. Nothing here depends on anything else, so read all three \
                  together rather than one at a time.",
    files: &[
        ("sensor/a.txt", "reading: 41\n"),
        ("sensor/b.txt", "reading: 17\n"),
        ("sensor/c.txt", "reading: 26\n"),
        // Not asked for. A model that reads the directory instead of the three
        // named files answers 93, which is wrong in a way a checksum of "did
        // it read three files" would have let through.
        ("sensor/d.txt", "reading: 9\n"),
    ],
    check: |o| {
        if !o.answer.contains("84") {
            if o.answer.contains("93") {
                return Err("summed sensor/d.txt too, which was not one of the three".into());
            }
            return Err(format!("expected 84, got: {}", one_line(o.answer)));
        }
        if o.trace.widest_round() < 3 {
            return Err(format!(
                "read them one at a time (shape {}); the task asks for one batch of three",
                o.trace.shape()
            ));
        }
        Ok(())
    },
};

/// Lowercase, with typographic punctuation folded to ASCII.
///
/// Not a nicety. An earlier version of the `absent-file` check failed a
/// correct answer from gpt-oss-20b purely because it wrote "couldn't" with a
/// curly apostrophe. That is the expensive direction for an eval to be wrong
/// in: a false failure sends someone hunting a bug that is not there.
fn normalize(s: &str) -> String {
    s.to_lowercase()
        .replace(['\u{2018}', '\u{2019}'], "'")
        .replace(['\u{201c}', '\u{201d}'], "\"")
        .replace(['\u{2013}', '\u{2014}'], "-")
}

fn read(dir: &Path, rel: &str) -> Result<String, String> {
    std::fs::read_to_string(dir.join(rel)).map_err(|e| format!("cannot read {rel}: {e}"))
}

fn one_line(s: &str) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.len() > 120 {
        format!("{}…", &flat[..120])
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::{Call, Outcome, Trace};

    /// Lay a task's fixture into a temp dir so a check can be exercised
    /// without spending a model call.
    ///
    /// `tag` is per *test*, not per task: two tests exercising the same task
    /// would otherwise derive the same path from the task name and the pid,
    /// and cargo runs them concurrently — one deleting its directory while
    /// the other reads it, which fails whichever loses the race.
    fn fixture(task: &Task, tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-suite-{}-{tag}-{}",
            task.name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        for (rel, contents) in task.files {
            let path = dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }
        dir
    }

    /// Run a check against the disk and an answer, with no tool calls
    /// recorded — the shape of the four tasks whose verdict is about files.
    fn verdict(task: &Task, dir: &Path, answer: &str) -> Result<(), String> {
        (task.check)(&Outcome {
            dir,
            answer,
            trace: &Trace::default(),
        })
    }

    fn verdict_with(task: &Task, dir: &Path, answer: &str, trace: &Trace) -> Result<(), String> {
        (task.check)(&Outcome { dir, answer, trace })
    }

    /// A trace from a sketch of it: one slice per round, each holding the
    /// argument text of that round's calls.
    fn trace(rounds: &[&[&str]]) -> Trace {
        Trace {
            rounds: rounds
                .iter()
                .map(|round| {
                    round
                        .iter()
                        .map(|input| Call {
                            name: "read_file".into(),
                            input: (*input).to_string(),
                        })
                        .collect()
                })
                .collect(),
        }
    }

    #[test]
    fn task_names_are_unique() {
        // The runner selects by name; two tasks sharing one would make
        // `--task` silently run only the first.
        let mut names: Vec<&str> = SUITE.iter().map(|t| t.name).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count);
    }

    #[test]
    fn one_call_wants_the_answer_and_the_shape() {
        let dir = fixture(&ONE_CALL, "one-call-wants-the-answe");
        let one = trace(&[&["{\"path\":\"beacon.txt\"}"]]);
        assert!(verdict_with(&ONE_CALL, &dir, "HX-7729", &one).is_ok());
        // Right answer, wrong shape: a listing it was told it did not need.
        let two = trace(&[&["{\"path\":\".\"}"], &["{\"path\":\"beacon.txt\"}"]]);
        let err = verdict_with(&ONE_CALL, &dir, "HX-7729", &two).unwrap_err();
        assert!(err.contains("2 calls"), "{err}");
        // No calls at all, with the right id, would mean it had been told —
        // and it has not been, so this only ever means a wrong answer.
        let err = verdict_with(&ONE_CALL, &dir, "HX-0000", &Trace::default()).unwrap_err();
        assert!(err.contains("HX-7729"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sequential_insists_the_three_reads_were_actually_chained() {
        let dir = fixture(&THREE_SEQUENTIAL, "sequential-insists-the-t");
        let chained = trace(&[
            &["{\"path\":\"start.txt\"}"],
            &["{\"path\":\"relay/7f/node.txt\"}"],
            &["{\"path\":\"relay/2c/node.txt\"}"],
        ]);
        assert!(verdict_with(&THREE_SEQUENTIAL, &dir, "QUARTZ-88", &chained).is_ok());

        // A model that had somehow learned all three names up front and read
        // them together got the answer, but not by following the trail.
        let batched = trace(&[&[
            "{\"path\":\"start.txt\"}",
            "{\"path\":\"relay/7f/node.txt\"}",
            "{\"path\":\"relay/2c/node.txt\"}",
        ]]);
        let err = verdict_with(&THREE_SEQUENTIAL, &dir, "QUARTZ-88", &batched).unwrap_err();
        assert!(err.contains("one batch"), "{err}");

        // A grep that surfaced every relay code at once, then a guess.
        let err = verdict_with(
            &THREE_SEQUENTIAL,
            &dir,
            "QUARTZ-88",
            &trace(&[&["{\"pattern\":\"relay code\"}"]]),
        )
        .unwrap_err();
        assert!(err.contains("all three files"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sequential_rejects_a_code_that_is_off_the_trail() {
        let dir = fixture(&THREE_SEQUENTIAL, "sequential-rejects-a-cod");
        // relay/5e points at relay/3d: a trail followed from the wrong start.
        let err = verdict(&THREE_SEQUENTIAL, &dir, "BASALT-12").unwrap_err();
        assert!(err.contains("not on the trail"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_windows_path_still_reads_as_the_file_it_names() {
        let dir = fixture(&THREE_SEQUENTIAL, "a-windows-path-still-rea");
        // What the JSON looks like when a model answers with an absolute path
        // on Windows: every separator doubled by the encoding.
        let chained = trace(&[
            &["{\"path\":\"C:\\\\tmp\\\\ws\\\\start.txt\"}"],
            &["{\"path\":\"C:\\\\tmp\\\\ws\\\\relay\\\\7f\\\\node.txt\"}"],
            &["{\"path\":\"C:\\\\tmp\\\\ws\\\\relay\\\\2c\\\\node.txt\"}"],
        ]);
        assert!(verdict_with(&THREE_SEQUENTIAL, &dir, "QUARTZ-88", &chained).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parallel_separates_a_wrong_sum_from_a_serial_read() {
        let dir = fixture(&THREE_PARALLEL, "parallel-separates-a-wro");
        let batch = trace(&[&[
            "{\"path\":\"sensor/a.txt\"}",
            "{\"path\":\"sensor/b.txt\"}",
            "{\"path\":\"sensor/c.txt\"}",
        ]]);
        assert!(verdict_with(&THREE_PARALLEL, &dir, "84", &batch).is_ok());

        // Right answer, one call at a time.
        let serial = trace(&[
            &["{\"path\":\"sensor/a.txt\"}"],
            &["{\"path\":\"sensor/b.txt\"}"],
            &["{\"path\":\"sensor/c.txt\"}"],
        ]);
        let err = verdict_with(&THREE_PARALLEL, &dir, "84", &serial).unwrap_err();
        assert!(err.contains("1,1,1"), "{err}");

        // Read the directory rather than the three files it was given.
        let err = verdict_with(&THREE_PARALLEL, &dir, "The sum is 93.", &batch).unwrap_err();
        assert!(err.contains("sensor/d.txt"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_fact_rejects_the_decommissioned_answer() {
        let dir = fixture(&FIND_FACT, "find-fact-rejects-the-de");
        assert!(verdict(&FIND_FACT, &dir, "48.6").is_ok());
        // Right phrase, wrong file — the trap the fixture exists to set.
        let err = verdict(&FIND_FACT, &dir, "3.1").unwrap_err();
        assert!(err.contains("decommissioned"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fix_value_fails_a_rewrite_that_lost_keys() {
        let dir = fixture(&FIX_VALUE, "fix-value-fails-a-rewrit");
        // The value is right, and the file has been regenerated from memory.
        std::fs::write(
            dir.join("config.toml"),
            "[client]\nretry_limit = 5\ntimeout_ms = 2500\n",
        )
        .unwrap();
        let err = verdict(&FIX_VALUE, &dir, "").unwrap_err();
        assert!(err.contains("lost"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_spares_a_similarly_named_function() {
        let dir = fixture(&RENAME_ACROSS_FILES, "rename-spares-a-similarl");
        for (rel, contents) in RENAME_ACROSS_FILES.files {
            std::fs::write(dir.join(rel), contents.replace("fetch_rows", "load_rows")).unwrap();
        }
        // legacy.py became load_rows_v1: a real rename, of the wrong thing.
        let err = verdict(&RENAME_ACROSS_FILES, &dir, "").unwrap_err();
        assert!(err.contains("different function"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_curly_apostrophe_still_reads_as_a_negation() {
        let dir = fixture(&ABSENT_FILE, "a-curly-apostrophe-still");
        // Observed live from gpt-oss-20b, and failed by an earlier version of
        // this check for the U+2019 alone.
        let answer = "I couldn\u{2019}t find a deploy/production.yaml file. \
                      The only YAML file under deploy/ is staging.yaml.";
        assert!(verdict(&ABSENT_FILE, &dir, answer).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn absent_file_catches_both_ways_of_faking_it() {
        let dir = fixture(&ABSENT_FILE, "absent-file-catches-both");
        assert!(verdict(&ABSENT_FILE, &dir, "There is no deploy/production.yaml.").is_ok());
        // Confabulation: staging's port, offered as production's.
        let err = verdict(&ABSENT_FILE, &dir, "It is not found; the port is 8080.").unwrap_err();
        assert!(err.contains("staging"), "{err}");
        // Making the request true instead of answering it.
        std::fs::write(dir.join("deploy/production.yaml"), "port: 80\n").unwrap();
        let err = verdict(&ABSENT_FILE, &dir, "It does not exist.").unwrap_err();
        assert!(err.contains("created the file"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
