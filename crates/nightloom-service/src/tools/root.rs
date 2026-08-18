//! Workspace confinement for every path-taking tool.

use std::path::{Component, Path, PathBuf};

/// The directory every path argument is resolved against, and outside of
/// which the file tools refuse to work.
///
/// Two checks run, because neither alone is sufficient:
///
/// * **Lexical.** `..` and `.` are resolved by walking components, without
///   touching the filesystem. This is the check that works for paths that do
///   not exist yet — which `write_file` needs, and which `Path::canonicalize`
///   cannot give us because it errors on a missing path.
/// * **Real.** The deepest *existing* ancestor of the candidate is
///   canonicalized and compared against the canonicalized root. This is what
///   catches a symlink inside the tree pointing out of it; no amount of
///   lexical normalization can see a symlink.
///
/// Because every tool operates on the *lexically normalized* path rather than
/// the raw argument, the classic `root/link/../secret` divergence (where the
/// OS would resolve `..` through the symlink and land outside) cannot bite:
/// we check and then open the same normalized path, so the check describes
/// the operation exactly.
///
/// Known limits — this is a guard rail, not a sandbox:
/// * It is a check at resolve time, so a path swapped for a symlink between
///   the check and the open (TOCTOU) is not covered.
/// * `bash` is not confined by it at all. Its working directory is set to the
///   root and that is the whole of it; its description says so plainly.
#[derive(Clone, Debug)]
pub struct Root {
    /// Absolute and lexically normalized, but *not* canonicalized: on Windows
    /// canonicalization yields a verbatim `\\?\C:\...` prefix that an
    /// absolute path typed by the model would never match, so keeping this
    /// form is what lets `starts_with` compare like with like.
    path: PathBuf,
    /// `path` canonicalized, used only for the symlink comparison where both
    /// sides are canonical. `None` when the root does not exist.
    real: Option<PathBuf>,
}

impl Root {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let raw = path.into();
        let absolute = if raw.is_absolute() {
            raw
        } else {
            std::env::current_dir().unwrap_or_default().join(raw)
        };
        let path = normalize(&absolute);
        let real = path.canonicalize().ok();
        Self { path, real }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Resolve a tool's path argument, or explain to the model why it cannot
    /// be used. A relative argument is taken relative to the root.
    pub fn resolve(&self, arg: &str) -> Result<PathBuf, String> {
        if arg.is_empty() {
            return Err("path must not be empty; use \".\" for the workspace root".to_string());
        }
        let raw = Path::new(arg);
        // `join` on Windows also replaces the whole path for a rooted-but-
        // driveless argument such as `\Users`, which is precisely why the
        // containment check below is applied to the joined result rather than
        // being assumed from the argument being relative.
        let joined = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            self.path.join(raw)
        };
        let candidate = normalize(&joined);
        if !candidate.starts_with(&self.path) {
            return Err(self.escaped(arg));
        }
        if let Some(real_root) = &self.real
            && let Some(existing) = deepest_existing(&candidate)
            && let Ok(real) = existing.canonicalize()
            && !real.starts_with(real_root)
        {
            return Err(self.escaped(arg));
        }
        Ok(candidate)
    }

    /// How a path inside the root should be shown back to the model: relative
    /// to the root, with forward slashes on every platform.
    pub fn show(&self, path: &Path) -> String {
        let relative = path.strip_prefix(&self.path).unwrap_or(path);
        let shown = relative.to_string_lossy().replace('\\', "/");
        if shown.is_empty() {
            ".".to_string()
        } else {
            shown
        }
    }

    fn escaped(&self, arg: &str) -> String {
        format!(
            "path \"{arg}\" is outside the workspace root ({}). The file tools only reach paths \
             inside that directory. Pass a path within it — a relative path is resolved from the \
             root, so \"src/main.rs\" works and \"../..\" does not.",
            self.path.display()
        )
    }
}

impl Default for Root {
    fn default() -> Self {
        Self::new(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }
}

/// Resolve `.` and `..` without consulting the filesystem. A `..` that would
/// climb past everything accumulated so far is kept verbatim, which makes the
/// result fail the containment check rather than silently clamping to the
/// root.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn deepest_existing(path: &Path) -> Option<PathBuf> {
    let mut cursor = path;
    loop {
        if cursor.exists() {
            return Some(cursor.to_path_buf());
        }
        cursor = cursor.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_dir;
    use std::fs;

    #[test]
    fn resolves_relative_paths_against_the_root() {
        let dir = test_dir("root-relative");
        let root = Root::new(&dir);
        let resolved = root.resolve("a/b.txt").unwrap();
        assert_eq!(resolved, normalize(&dir.join("a").join("b.txt")));
        assert_eq!(root.show(&resolved), "a/b.txt");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn accepts_a_path_that_does_not_exist_yet() {
        let dir = test_dir("root-missing");
        let root = Root::new(&dir);
        assert!(root.resolve("deep/nested/new.txt").is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_dot_dot_escapes() {
        let dir = test_dir("root-dotdot");
        let root = Root::new(&dir);
        let err = root.resolve("../../secrets.txt").unwrap_err();
        assert!(err.contains("outside the workspace root"), "{err}");
        // Interior `..` that stays inside is fine.
        assert!(root.resolve("a/../b.txt").is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_absolute_paths_outside_the_root() {
        let dir = test_dir("root-absolute");
        let root = Root::new(&dir);
        let outside = dir.parent().unwrap().join("elsewhere.txt");
        let err = root.resolve(outside.to_str().unwrap()).unwrap_err();
        assert!(err.contains("outside the workspace root"), "{err}");
        // An absolute path *inside* the root is accepted.
        assert!(
            root.resolve(dir.join("inside.txt").to_str().unwrap())
                .is_ok()
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_a_sibling_directory_sharing_a_name_prefix() {
        let dir = test_dir("root-prefix");
        let root = Root::new(&dir);
        let sibling = format!("{}-evil/file.txt", dir.to_str().unwrap());
        assert!(root.resolve(&sibling).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_a_symlink_pointing_out_of_the_root() {
        let dir = test_dir("root-symlink");
        let inside = dir.join("workspace");
        let outside = dir.join("outside");
        fs::create_dir_all(&inside).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "shh").unwrap();

        let link = inside.join("escape");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, &link).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, &link).is_ok();

        // Creating a symlink on Windows needs Developer Mode or elevation;
        // where it is unavailable the lexical half is still covered above.
        if made {
            let root = Root::new(&inside);
            let err = root.resolve("escape/secret.txt").unwrap_err();
            assert!(err.contains("outside the workspace root"), "{err}");
        }
        fs::remove_dir_all(&dir).ok();
    }
}
