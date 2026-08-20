//! Workspace confinement for every path-taking tool.

use std::path::{Component, Path, PathBuf};

/// One permitted tree.
#[derive(Clone, Debug)]
struct Anchor {
    /// Absolute and lexically normalized, but *not* canonicalized: on Windows
    /// canonicalization yields a verbatim `\\?\C:\...` prefix that an
    /// absolute path typed by the model would never match, so keeping this
    /// form is what lets `starts_with` compare like with like.
    path: PathBuf,
    /// `path` canonicalized, used only for the symlink comparison where both
    /// sides are canonical. `None` when the tree does not exist.
    real: Option<PathBuf>,
}

impl Anchor {
    fn new(path: PathBuf) -> Self {
        let real = path.canonicalize().ok();
        Self { path, real }
    }

    /// Whether `candidate` — already lexically normalized — is inside this
    /// tree, by *both* checks.
    ///
    /// Split out because it is now run against several trees, and running
    /// only half of it against one of them is precisely the hole the
    /// two-check design exists to close.
    fn holds(&self, candidate: &Path) -> bool {
        if !candidate.starts_with(&self.path) {
            return false;
        }
        if let Some(real_root) = &self.real
            && let Some(existing) = deepest_existing(candidate)
            && let Ok(real) = existing.canonicalize()
            && !real.starts_with(real_root)
        {
            return false;
        }
        true
    }
}

/// The directories every path argument is resolved against, and outside of
/// which the file tools refuse to work.
///
/// There is a **primary** tree — the workspace, which relative arguments
/// resolve against and which paths are displayed relative to — and zero or
/// more additional trees.
///
/// The docspace is the only additional tree today, and it is the reason they
/// exist: notes live under `~/.nightloom` rather than in the project folder,
/// so a single-tree root would leave the model unable to read the notes its
/// own system prompt indexes. Of the two ways out, this is the smaller — the
/// other being a note-shaped `read`/`write` pair beside the file tools, which
/// is a second way to do what `read_file` already does, one more surface to
/// classify for `Effect`, and a second implementation of the containment
/// argument to keep in step with this one.
///
/// Two checks run per tree, because neither alone is sufficient:
///
/// * **Lexical.** `..` and `.` are resolved by walking components, without
///   touching the filesystem. This is the check that works for paths that do
///   not exist yet — which `write_file` needs, and which `Path::canonicalize`
///   cannot give us because it errors on a missing path.
/// * **Real.** The deepest *existing* ancestor of the candidate is
///   canonicalized and compared against the canonicalized tree. This is what
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
///   primary tree and that is the whole of it; its description says so
///   plainly. It does not gain the additional trees and does not need to —
///   it never had a boundary for them to widen.
#[derive(Clone, Debug)]
pub struct Root {
    primary: Anchor,
    /// Each additional tree with the name the model is told for it, so a
    /// refusal can say where else it is allowed to reach.
    extra: Vec<(String, Anchor)>,
}

impl Root {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            primary: Anchor::new(absolutize(path.into())),
            extra: Vec::new(),
        }
    }

    /// Permit an additional tree, named for the refusal message.
    ///
    /// A tree that is already inside the primary one is dropped rather than
    /// added: it is reachable as it stands, and keeping it would give `show`
    /// two renderings of one path. That is not hypothetical — a docspace
    /// pointed back inside the workspace is exactly the pre-move layout, and
    /// an imported project can still be sitting in it.
    pub fn with(mut self, name: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        let anchor = Anchor::new(absolutize(path.into()));
        if anchor.path.starts_with(&self.primary.path)
            || self.extra.iter().any(|(_, a)| a.path == anchor.path)
        {
            return self;
        }
        self.extra.push((name.into(), anchor));
        self
    }

    pub fn path(&self) -> &Path {
        &self.primary.path
    }

    /// Resolve a tool's path argument, or explain to the model why it cannot
    /// be used. A relative argument is taken relative to the primary tree.
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
            self.primary.path.join(raw)
        };
        let candidate = normalize(&joined);
        // Containment is judged on where the path *lands*, never on how it was
        // spelled — so a relative `../notes/x.md` that normalizes into the
        // docspace is allowed, exactly as the absolute spelling of the same
        // file is. Refusing it would be a second rule, weaker than this one
        // and disagreeing with it, which is the divergence the check-then-open
        // discipline above exists to avoid. It grants nothing extra either:
        // the destination is a permitted tree however the model got there.
        if self.primary.holds(&candidate) || self.extra.iter().any(|(_, a)| a.holds(&candidate)) {
            return Ok(candidate);
        }
        Err(self.escaped(arg))
    }

    /// How a path inside the root should be shown back to the model: relative
    /// to the primary tree, with forward slashes on every platform.
    ///
    /// Only the primary tree gets a relative rendering. A path in an
    /// additional tree is shown in full, because what `show` returns is what
    /// the model passes back on its next call, and a bare `decisions.md`
    /// would resolve against the workspace — a different file, or no file.
    pub fn show(&self, path: &Path) -> String {
        let Ok(relative) = path.strip_prefix(&self.primary.path) else {
            return path.to_string_lossy().replace('\\', "/");
        };
        let shown = relative.to_string_lossy().replace('\\', "/");
        if shown.is_empty() {
            ".".to_string()
        } else {
            shown
        }
    }

    fn escaped(&self, arg: &str) -> String {
        let mut msg = format!(
            "path \"{arg}\" is outside the workspace root ({}). The file tools only reach paths \
             inside that directory. Pass a path within it — a relative path is resolved from the \
             root, so \"src/main.rs\" works and \"../..\" does not.",
            self.primary.path.display()
        );
        for (name, anchor) in &self.extra {
            msg.push_str(&format!(
                " The {name} is reachable too, by its full path ({}).",
                anchor.path.display()
            ));
        }
        msg
    }
}

impl Default for Root {
    fn default() -> Self {
        Self::new(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }
}

impl From<PathBuf> for Root {
    fn from(path: PathBuf) -> Self {
        Root::new(path)
    }
}

impl From<&Path> for Root {
    fn from(path: &Path) -> Self {
        Root::new(path.to_path_buf())
    }
}

impl From<&PathBuf> for Root {
    fn from(path: &PathBuf) -> Self {
        Root::new(path.clone())
    }
}

impl From<&str> for Root {
    fn from(path: &str) -> Self {
        Root::new(PathBuf::from(path))
    }
}

/// A relative path is taken from the process's cwd, which is the right
/// reading for a CLI argument and the reason a GUI must always pass an
/// absolute one.
fn absolutize(raw: PathBuf) -> PathBuf {
    let absolute = if raw.is_absolute() {
        raw
    } else {
        std::env::current_dir().unwrap_or_default().join(raw)
    };
    normalize(&absolute)
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

    #[test]
    fn an_extra_tree_is_reachable_and_its_neighbours_are_not() {
        let dir = test_dir("root-extra");
        let workspace = dir.join("work");
        let notes = dir.join("notes");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&notes).unwrap();

        let root = Root::new(&workspace).with("docspace", &notes);
        let note = notes.join("decisions.md");
        assert!(root.resolve(note.to_str().unwrap()).is_ok());
        // Permitting one tree must not permit its parent, so the sibling the
        // docspace sits beside is still refused — as is the parent itself.
        assert!(
            root.resolve(dir.join("other.txt").to_str().unwrap())
                .is_err()
        );
        assert!(root.resolve("../secrets.txt").is_err());
        // A `..` that lands *in* the docspace is allowed, because the rule is
        // about the destination and not the spelling. The alternative is a
        // second, spelling-based rule that disagrees with this one.
        assert!(root.resolve("../notes/decisions.md").is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_path_in_an_extra_tree_is_shown_in_full() {
        let dir = test_dir("root-extra-show");
        let workspace = dir.join("work");
        let notes = dir.join("notes");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&notes).unwrap();

        let root = Root::new(&workspace).with("docspace", &notes);
        let resolved = root
            .resolve(notes.join("decisions.md").to_str().unwrap())
            .unwrap();
        let shown = root.show(&resolved);
        // Round-trips: what the model is shown is what it may pass back.
        assert!(shown.ends_with("notes/decisions.md"), "{shown}");
        assert_eq!(root.resolve(&shown).unwrap(), resolved);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_extra_tree_inside_the_workspace_is_dropped() {
        let dir = test_dir("root-extra-nested");
        let notes = dir.join(".nightloom").join("notes");
        fs::create_dir_all(&notes).unwrap();

        let root = Root::new(&dir).with("docspace", &notes);
        let resolved = root.resolve(notes.join("a.md").to_str().unwrap()).unwrap();
        // Still one rendering of the path, relative to the workspace: adding
        // a tree already inside it must not change how it is shown.
        assert_eq!(root.show(&resolved), ".nightloom/notes/a.md");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_refusal_names_the_extra_tree() {
        let dir = test_dir("root-extra-msg");
        let workspace = dir.join("work");
        let notes = dir.join("notes");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&notes).unwrap();

        let root = Root::new(&workspace).with("docspace", &notes);
        let err = root.resolve("../../secrets.txt").unwrap_err();
        // A model told only "outside the workspace" would conclude the notes
        // its system prompt indexes are unreachable.
        assert!(err.contains("docspace"), "{err}");
        assert!(err.contains(&notes.display().to_string()), "{err}");
        fs::remove_dir_all(&dir).ok();
    }
}
