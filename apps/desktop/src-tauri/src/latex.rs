//! A `.tex` file tab's rendered side (nightshift backlog 381): the file
//! compiled to a PDF by the TeX on this Mac, the output kept in Nightloom's
//! cache and never beside his file.
//!
//! TeX is found by absolute path (`/Library/TeX/texbin`, MacTeX's link
//! folder): the app opened from the Finder has no shell `PATH`. `latexmk`
//! when it is there (it reruns for references), else `pdflatex` once. Both
//! run with shell escape off, `nonstopmode`, halt on the first error, the
//! file's own folder as the working directory (so `\input` resolves) and the
//! output directory in the cache, keyed by a hash of the file's path.
//! `latexmk -norc`: a `latexmkrc` beside his file is Perl and is not run.
//! A run past the time limit is killed with its whole process group.

use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// MacTeX's folder of links to the TeX programs.
pub const TEXBIN: &str = "/Library/TeX/texbin";
/// How long a compile may run before it is stopped.
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// The most of the log handed to the pane (its first error is near the top
/// of the tail TeX writes; a runaway log is cut from the front).
const MAX_LOG: usize = 512 * 1024;

/// What a render produced, for the pane.
#[derive(Debug, serde::Serialize)]
pub struct Render {
    /// The PDF, base64, when the compile succeeded.
    pub pdf: Option<String>,
    /// No TeX on this Mac: the pane says so and shows the source only.
    pub missing_tex: bool,
    /// The TeX log (`<name>.log`), for the pane's error line.
    pub log: Option<String>,
    /// What went wrong in words when there is no log to read it from (the
    /// time limit, a program that would not start), or the program's own
    /// output when it failed without one.
    pub message: Option<String>,
}

/// The TeX program to run from `bin`: `latexmk` first, `pdflatex` else.
pub fn engine(bin: &Path) -> Option<PathBuf> {
    ["latexmk", "pdflatex"]
        .iter()
        .map(|n| bin.join(n))
        .find(|p| p.is_file())
}

/// The output folder for `file` under `cache`: one per source path.
pub fn out_dir(cache: &Path, file: &Path) -> PathBuf {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    file.hash(&mut h);
    cache.join("latex").join(format!("{:016x}", h.finish()))
}

/// Compile `file` with the TeX in `bin` into `out`. Never writes beside
/// `file`: every output goes to `out`.
pub async fn compile(file: &Path, out: &Path, bin: &Path, timeout: Duration) -> Render {
    let Some(engine) = engine(bin) else {
        return Render {
            pdf: None,
            missing_tex: true,
            log: None,
            message: None,
        };
    };
    let failed = |message: String| Render {
        pdf: None,
        missing_tex: false,
        log: None,
        message: Some(message),
    };
    let (Some(dir), Some(name), Some(stem)) = (file.parent(), file.file_name(), file.file_stem())
    else {
        return failed(format!("{} is not a file in a folder", file.display()));
    };
    if let Err(e) = std::fs::create_dir_all(out) {
        return failed(format!("Could not make the render folder: {e}"));
    }
    let stem = stem.to_string_lossy();
    let pdf_path = out.join(format!("{stem}.pdf"));
    let log_path = out.join(format!("{stem}.log"));
    // A failed run must not show the last good PDF, nor an old log.
    let _ = std::fs::remove_file(&pdf_path);
    let _ = std::fs::remove_file(&log_path);

    let latexmk = engine.file_name().is_some_and(|n| n == "latexmk");
    let mut cmd = tokio::process::Command::new(&engine);
    if latexmk {
        cmd.arg("-norc")
            .arg("-pdf")
            .arg("-g")
            .arg(format!("-outdir={}", out.display()));
    } else {
        cmd.arg(format!("-output-directory={}", out.display()));
    }
    cmd.arg("-no-shell-escape")
        .arg("-interaction=nonstopmode")
        .arg("-halt-on-error")
        // `./name`, never the bare name: a file named `-pdflatex=cmd.tex` is
        // otherwise read by latexmk as an option and runs `cmd` (review 381).
        .arg(Path::new(".").join(name))
        .current_dir(dir)
        // latexmk finds pdflatex (and perl) by name.
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", bin.display()),
        )
        // TeX's own writes (\openout) land in the output folder too.
        .env("TEXMFOUTPUT", out)
        // Paranoid writes (TeX Live's default, pinned against a loosened
        // texmf.cnf or environment): no absolute path outside the output
        // folder, no `..`, no dot files, so \openout cannot reach his folder.
        .env("openout_any", "p")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return failed(format!("Could not start {}: {e}", engine.display())),
    };
    let pid = child.id();
    let ran = tokio::time::timeout(timeout, child.wait_with_output()).await;
    let output = match ran {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return failed(format!("{} failed to run: {e}", engine.display())),
        Err(_) => {
            // latexmk's pdflatex is its child: stop the whole group.
            #[cfg(unix)]
            if let Some(pid) = pid.and_then(|p| i32::try_from(p).ok()) {
                // SAFETY: a signal to the process group this call made.
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
            let mut r = failed(format!(
                "TeX ran past {} seconds and was stopped",
                timeout.as_secs()
            ));
            r.log = read_log(&log_path);
            return r;
        }
    };
    let log = read_log(&log_path);
    if output.status.success()
        && let Ok(bytes) = std::fs::read(&pdf_path)
    {
        use base64::Engine as _;
        return Render {
            pdf: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            missing_tex: false,
            log,
            message: None,
        };
    }
    let said = String::from_utf8_lossy(&output.stdout).into_owned()
        + &String::from_utf8_lossy(&output.stderr);
    let tail: String = {
        let lines: Vec<&str> = said.lines().filter(|l| !l.trim().is_empty()).collect();
        lines[lines.len().saturating_sub(12)..].join("\n")
    };
    Render {
        pdf: None,
        missing_tex: false,
        log,
        message: Some(if tail.is_empty() {
            format!("TeX stopped ({})", output.status)
        } else {
            tail
        }),
    }
}

/// A `.tex` tab's Render and Re-render (backlog 381): `path` compiled when
/// `chat` may read it — the same rule, and refusal, as the tab's own read
/// (`read_file_tab`). The output goes to the app's cache folder.
#[tauri::command]
pub async fn render_latex(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    path: String,
    chat: Option<String>,
) -> Result<Render, String> {
    use tauri::Manager as _;
    crate::read_file_tab(state, path.clone(), chat).await?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let file = PathBuf::from(&path);
    let out = out_dir(&cache, &file);
    Ok(compile(&file, &out, Path::new(TEXBIN), TIMEOUT).await)
}

fn read_log(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if text.len() <= MAX_LOG {
        return Some(text);
    }
    let mut cut = text.len() - MAX_LOG;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    Some(text[cut..].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nightloom-latex-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn listing(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn the_output_folder_is_per_path_and_under_the_cache() {
        let cache = Path::new("/c");
        let a = out_dir(cache, Path::new("/x/a.tex"));
        let b = out_dir(cache, Path::new("/x/b.tex"));
        assert!(a.starts_with("/c/latex"));
        assert_ne!(a, b);
        assert_eq!(a, out_dir(cache, Path::new("/x/a.tex")));
    }

    #[tokio::test]
    async fn no_tex_reads_as_missing_rather_than_an_error() {
        let src = scratch("none");
        let file = src.join("t.tex");
        std::fs::write(&file, "x").unwrap();
        let r = compile(&file, &src.join("out"), &src.join("no-bin"), TIMEOUT).await;
        assert!(r.missing_tex);
        assert!(r.pdf.is_none());
    }

    /// A tiny `.tex` compiles to a PDF in the output folder and nothing new
    /// appears beside it; an error comes back in the log. Skipped cleanly
    /// where no TeX is installed.
    #[tokio::test]
    async fn a_tex_file_compiles_into_the_cache_and_an_error_comes_back_in_the_log() {
        if engine(Path::new(TEXBIN)).is_none() {
            eprintln!("skipped: no TeX at {TEXBIN}");
            return;
        }
        let src = scratch("src");
        let out = scratch("out");
        let file = src.join("table.tex");
        std::fs::write(
            &file,
            "\\documentclass[border=10pt,12pt]{standalone}\n\\begin{document}\n\
             \\begin{tabular}{|c|c|}\\hline a & b \\\\ \\hline\\end{tabular}\n\\end{document}\n",
        )
        .unwrap();
        let before = listing(&src);
        let r = compile(&file, &out, Path::new(TEXBIN), TIMEOUT).await;
        assert!(r.pdf.is_some(), "no PDF: {:?}", r.message);
        assert!(out.join("table.pdf").is_file());
        assert_eq!(
            listing(&src),
            before,
            "something was written beside the file"
        );

        std::fs::write(
            &file,
            "\\documentclass{article}\n\\begin{document}\nok\n\\nosuchmacro\n\\end{document}\n",
        )
        .unwrap();
        let r = compile(&file, &out, Path::new(TEXBIN), TIMEOUT).await;
        assert!(r.pdf.is_none());
        assert!(!out.join("table.pdf").exists(), "the old PDF was kept");
        let log = r.log.expect("a log");
        assert!(log.contains("! Undefined control sequence."), "{log}");
        assert!(log.contains("l.4 \\nosuchmacro"), "{log}");
        assert_eq!(listing(&src), before);
    }

    /// A file whose name reads as an option is compiled as a file: without
    /// `./` latexmk took `-pdflatex=touch PWNED.tex` as its TeX command and
    /// ran it beside the file (review 381).
    #[tokio::test]
    async fn a_name_that_reads_as_an_option_is_compiled_not_obeyed() {
        if engine(Path::new(TEXBIN)).is_none() {
            eprintln!("skipped: no TeX at {TEXBIN}");
            return;
        }
        let src = scratch("dash name");
        let out = scratch("dash-out");
        let file = src.join("-pdflatex=touch PWNED.tex");
        std::fs::write(
            &file,
            "\\documentclass{article}\n\\begin{document}\nok\n\\end{document}\n",
        )
        .unwrap();
        let before = listing(&src);
        let r = compile(&file, &out, Path::new(TEXBIN), TIMEOUT).await;
        assert_eq!(listing(&src), before, "a command ran beside the file");
        assert!(r.pdf.is_some(), "no PDF: {:?}", r.message);
    }

    /// A compile that never ends is stopped at the limit, with its children
    /// (latexmk's pdflatex): nothing of it is left running.
    #[tokio::test]
    async fn a_compile_past_the_limit_is_stopped_with_its_children() {
        if engine(Path::new(TEXBIN)).is_none() {
            eprintln!("skipped: no TeX at {TEXBIN}");
            return;
        }
        let src = scratch("loop");
        let out = scratch("loop-out");
        // A stem no other process has on its command line, for pgrep.
        let stem = format!(
            "forever{}x{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let file = src.join(format!("{stem}.tex"));
        std::fs::write(&file, "\\def\\x{\\x}\\x\n").unwrap();
        let started = std::time::Instant::now();
        let r = compile(&file, &out, Path::new(TEXBIN), Duration::from_secs(3)).await;
        assert!(started.elapsed() < Duration::from_secs(20));
        assert!(r.pdf.is_none());
        assert!(
            r.message
                .as_deref()
                .is_some_and(|m| m.contains("was stopped")),
            "{:?}",
            r.message
        );
        // The group's kill lands asynchronously; give it a moment.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let left = std::process::Command::new("/usr/bin/pgrep")
            .args(["-f", &stem])
            .output()
            .unwrap();
        assert!(
            left.stdout.is_empty(),
            "still running: {}",
            String::from_utf8_lossy(&left.stdout)
        );
    }
}
