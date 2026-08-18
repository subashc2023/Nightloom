//! The built-in task suite.
//!
//! Every task here obeys two rules. Its answer cannot be known in advance —
//! the facts are invented, so a model that guesses is wrong and a model that
//! reads is right. And its check is mechanical, so a pass is a fact about the
//! disk rather than a judgement about the prose.
//!
//! They are small on purpose. A task that takes forty tool calls tells you
//! that something went wrong somewhere; a task that takes three tells you
//! where.

use crate::task::Task;
use std::path::Path;

/// Every task, in rough order of difficulty.
pub const SUITE: &[Task] = &[FIND_FACT, FIX_VALUE, RENAME_ACROSS_FILES, ABSENT_FILE];

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
    check: |_, answer| {
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
    check: |dir, _| {
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
    check: |dir, _| {
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
    check: |dir, answer| {
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
    fn find_fact_rejects_the_decommissioned_answer() {
        let dir = fixture(&FIND_FACT, "find-fact-rejects-the-de");
        assert!((FIND_FACT.check)(&dir, "48.6").is_ok());
        // Right phrase, wrong file — the trap the fixture exists to set.
        let err = (FIND_FACT.check)(&dir, "3.1").unwrap_err();
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
        let err = (FIX_VALUE.check)(&dir, "").unwrap_err();
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
        let err = (RENAME_ACROSS_FILES.check)(&dir, "").unwrap_err();
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
        assert!((ABSENT_FILE.check)(&dir, answer).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn absent_file_catches_both_ways_of_faking_it() {
        let dir = fixture(&ABSENT_FILE, "absent-file-catches-both");
        assert!((ABSENT_FILE.check)(&dir, "There is no deploy/production.yaml.").is_ok());
        // Confabulation: staging's port, offered as production's.
        let err = (ABSENT_FILE.check)(&dir, "It is not found; the port is 8080.").unwrap_err();
        assert!(err.contains("staging"), "{err}");
        // Making the request true instead of answering it.
        std::fs::write(dir.join("deploy/production.yaml"), "port: 80\n").unwrap();
        let err = (ABSENT_FILE.check)(&dir, "It does not exist.").unwrap_err();
        assert!(err.contains("created the file"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
