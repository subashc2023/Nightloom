//! Workspace confinement for every path-taking tool.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

/// How the knowledge vault is addressed: `@kb/<name>`.
///
/// A prefix rather than an absolute path, because an absolute path is
/// machine-specific noise in every tool call the model writes and is the exact
/// spelling the docspace's own prompt got wrong for thirteen commits. A `@`
/// rather than a bare `kb/`, because the alias shadows whatever it is spelled
/// like: `@kb` is not a name a directory at a workspace root is called, and
/// `kb` very well might be. The shadowing is documented rather than defended
/// against — the alternative is asking the filesystem which reading was meant,
/// and addressing that resolves differently depending on what exists is worse
/// than addressing that is occasionally inconvenient.
pub const VAULT_ALIAS: &str = "@kb";

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
    /// Split out from `resolve` so the two halves stay together: running
    /// only one of them is precisely the hole the two-check design closes.
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

/// The directory every path argument is resolved against, and outside of
/// which the file tools refuse to work.
///
/// **A workspace, plus at most one named tree** — never an open-ended set.
/// The workspace is the default: every relative path resolves against it, and
/// a `Root` built without a vault behaves exactly as it always did.
///
/// The second tree was arrived at twice, and the two occasions are worth
/// telling apart. The first was a *docspace* that had briefly moved to
/// `~/.nightloom`, where it could be indexed into the system prompt and never
/// opened; a second tree was the wrong fix and moving the notes back inside
/// the workspace was the right one, because notes about code belong with the
/// code — reachable by a plain relative path, found by `grep` in an ordinary
/// walk. The second occasion is the knowledge vault, and that argument does
/// not transfer: the vault holds what the *user* knows rather than what this
/// folder contains, so there is no workspace to move it into. A thing that
/// must be reachable from every project, and from a chat with no project at
/// all, cannot live inside any one of them.
///
/// So the vault is addressed [`VAULT_ALIAS`], and every path-taking tool
/// inherits it without a new tool or a retrieval layer. Two rules keep it from
/// surprising anyone:
///
/// * The workspace is checked **first**, so a vault nested inside a workspace
///   renders and resolves as an ordinary workspace path. Addressing never
///   depends on which of two readings the filesystem happens to support.
/// * A bare `grep`/`glob` with no `path` still walks the workspace only.
///   Reaching the vault is explicit, which is what keeps today's searches
///   byte-identical for anyone not asking about it.
///
/// Two checks run, because neither alone is sufficient:
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
///   root and that is the whole of it; its description says so plainly.
#[derive(Clone, Debug)]
pub struct Root {
    tree: Anchor,
    /// The knowledge vault, reached as `@kb/…`. `None` when the shell did not
    /// offer one, which is the whole of what "the vault is off" means — there
    /// is no flag to disagree with a tree that is not there.
    vault: Option<Anchor>,
}

impl Root {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            tree: Anchor::new(absolutize(path.into())),
            vault: None,
        }
    }

    /// Attach the knowledge vault, addressed [`VAULT_ALIAS`].
    ///
    /// A builder rather than a second constructor so that the callers that
    /// have no vault — the eval harness, every test, a `review` sub-chat —
    /// keep the constructor they already use and get today's behaviour by
    /// saying nothing.
    pub fn with_vault(mut self, path: impl Into<PathBuf>) -> Self {
        self.vault = Some(Anchor::new(absolutize(path.into())));
        self
    }

    pub fn path(&self) -> &Path {
        &self.tree.path
    }

    /// The vault's directory, or `None` when this root has no vault.
    pub fn vault_path(&self) -> Option<&Path> {
        self.vault.as_ref().map(|v| v.path.as_path())
    }

    /// The clause every path-taking tool appends to its `path` description,
    /// and nothing at all when there is no vault.
    ///
    /// Here rather than written out six times because it is the sentence that
    /// decides whether the vault is ever *reached*. `glob` and `grep` route
    /// their `path` through `resolve` and report through `show`, so searching
    /// the vault already works — but a description reading "relative to the
    /// workspace root" tells the model it does not, and a model told that will
    /// not try. That is the docspace's own bug, which said the notes were
    /// somewhere else and cost the affordance for thirteen commits while every
    /// call kept succeeding. A tool definition is the outermost layer of the
    /// prompt cache, so this must be fixed for the life of the `Chat` — which
    /// it is, the vault being decided at connect time and never per turn.
    pub fn path_hint(&self) -> &'static str {
        if self.vault.is_some() {
            " A path beginning \"@kb/\" reaches the knowledge vault instead, which is outside \
             the workspace."
        } else {
            ""
        }
    }

    /// Resolve a tool's path argument, or explain to the model why it cannot
    /// be used. A relative argument is taken relative to the workspace; one
    /// beginning `@kb` is taken relative to the vault.
    pub fn resolve(&self, arg: &str) -> Result<PathBuf, String> {
        if arg.is_empty() {
            return Err("path must not be empty; use \".\" for the workspace root".to_string());
        }
        // The alias is answered before anything else, so that what `@kb/x`
        // means cannot depend on whether a directory called `@kb` happens to
        // exist in the workspace.
        if let Some(rest) = strip_alias(arg) {
            let Some(vault) = &self.vault else {
                return Err(format!(
                    "path \"{arg}\" names the knowledge vault, which is not available in this \
                     session. Only the workspace ({}) can be reached from here.",
                    self.tree.path.display()
                ));
            };
            let candidate = normalize(&vault.path.join(rest));
            if vault.holds(&candidate) {
                return Ok(candidate);
            }
            return Err(self.escaped(arg));
        }
        let raw = Path::new(arg);
        // `join` on Windows also replaces the whole path for a rooted-but-
        // driveless argument such as `\Users`, which is precisely why the
        // containment check below is applied to the joined result rather than
        // being assumed from the argument being relative.
        let joined = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            self.tree.path.join(raw)
        };
        let candidate = normalize(&joined);
        // Judged on where the path *lands*, never on how it was spelled. The
        // vault is checked too, so its absolute spelling is the same file
        // rather than a refusal — the alias is the shorthand, not a gate.
        if self.tree.holds(&candidate) {
            return Ok(candidate);
        }
        if let Some(vault) = &self.vault
            && vault.holds(&candidate)
        {
            return Ok(candidate);
        }
        Err(self.escaped(arg))
    }

    /// How a path inside the root should be shown back to the model: relative
    /// to the workspace, or `@kb/…` for one in the vault, with forward slashes
    /// on every platform.
    ///
    /// What this returns is what the model passes back on its next call, so it
    /// has to round-trip through `resolve` — which is why the search tools
    /// report through it rather than relative to whatever directory they
    /// happened to be walking, and why the alias has to be *emitted* here and
    /// not only accepted above.
    pub fn show(&self, path: &Path) -> String {
        // The workspace first, so a vault nested inside one renders the way it
        // did before there was a vault.
        if let Ok(relative) = path.strip_prefix(&self.tree.path) {
            return slashed(relative).unwrap_or_else(|| ".".to_string());
        }
        if let Some(vault) = &self.vault
            && let Ok(relative) = path.strip_prefix(&vault.path)
        {
            return match slashed(relative) {
                Some(rest) => format!("{VAULT_ALIAS}/{rest}"),
                None => VAULT_ALIAS.to_string(),
            };
        }
        slashed(path).unwrap_or_else(|| ".".to_string())
    }

    fn escaped(&self, arg: &str) -> String {
        let mut message = format!(
            "path \"{arg}\" is outside the workspace root ({}). The file tools only reach paths \
             inside that directory",
            self.tree.path.display()
        );
        match &self.vault {
            Some(vault) => message.push_str(&format!(
                " and the knowledge vault ({}). Pass a path within one — a relative path is \
                 resolved from the workspace, so \"src/main.rs\" works and \"../..\" does not, \
                 and \"{VAULT_ALIAS}/<name>\" reaches the vault.",
                vault.path.display()
            )),
            None => message.push_str(
                ". Pass a path within it — a relative path is resolved from the root, so \
                 \"src/main.rs\" works and \"../..\" does not.",
            ),
        }
        message
    }
}

/// The remainder of an argument that begins with [`VAULT_ALIAS`], or `None`.
///
/// Matched on *components* rather than by a string prefix: `@kbd/notes` starts
/// with the same three characters and is an ordinary workspace path, and on
/// Windows the separator may be either slash.
fn strip_alias(arg: &str) -> Option<PathBuf> {
    let mut components = Path::new(arg).components();
    match components.next() {
        Some(Component::Normal(first)) if first == OsStr::new(VAULT_ALIAS) => {
            Some(components.as_path().to_path_buf())
        }
        _ => None,
    }
}

/// A path as forward-slashed text, or `None` when it is empty — which is what
/// `strip_prefix` returns for the tree itself and what the callers above each
/// spell differently.
fn slashed(path: &Path) -> Option<String> {
    let text = path.to_string_lossy().replace('\\', "/");
    (!text.is_empty()).then_some(text)
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

    /// The docspace is inside the workspace, so it needs no special case —
    /// which is the point of putting it there. This pins that a `.agents`
    /// directory is ordinary as far as `Root` is concerned, so that moving it
    /// back out would break a test rather than quietly need a second tree.
    #[test]
    fn the_docspace_is_an_ordinary_path_inside_the_root() {
        let dir = test_dir("root-docspace");
        let notes = dir.join(".agents");
        fs::create_dir_all(&notes).unwrap();
        let root = Root::new(&dir);

        let resolved = root.resolve(".agents/decisions.md").unwrap();
        assert_eq!(root.show(&resolved), ".agents/decisions.md");
        // Round-trips, which is the property the search tools depend on.
        assert_eq!(root.resolve(&root.show(&resolved)).unwrap(), resolved);
        // And the absolute spelling is the same file, not a refusal.
        assert_eq!(
            root.resolve(notes.join("decisions.md").to_str().unwrap())
                .unwrap(),
            resolved
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// The property every search tool leans on, now for the second tree: what
    /// `show` prints is what `resolve` takes back.
    #[test]
    fn the_vault_is_reached_by_its_alias_and_round_trips() {
        let dir = test_dir("root-vault");
        let workspace = dir.join("workspace");
        let vault = dir.join("vault");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(vault.join("rust")).unwrap();
        let root = Root::new(&workspace).with_vault(&vault);

        let resolved = root.resolve("@kb/rust/async.md").unwrap();
        assert_eq!(resolved, normalize(&vault.join("rust").join("async.md")));
        assert_eq!(root.show(&resolved), "@kb/rust/async.md");
        assert_eq!(root.resolve(&root.show(&resolved)).unwrap(), resolved);

        // The alias alone is the vault itself.
        assert_eq!(root.resolve("@kb").unwrap(), normalize(&vault));
        assert_eq!(root.show(&normalize(&vault)), "@kb");

        // The absolute spelling is the same file rather than a refusal: the
        // alias is shorthand, not a gate.
        assert_eq!(
            root.resolve(vault.join("rust").join("async.md").to_str().unwrap())
                .unwrap(),
            resolved
        );

        // The workspace is untouched by any of it.
        let src = root.resolve("src/main.rs").unwrap();
        assert_eq!(root.show(&src), "src/main.rs");
        fs::remove_dir_all(&dir).ok();
    }

    /// The alias is not a way out of the containment argument — it selects
    /// which tree the two checks run against, and then they run.
    #[test]
    fn the_alias_cannot_climb_out_of_the_vault() {
        let dir = test_dir("root-vault-escape");
        let workspace = dir.join("workspace");
        let vault = dir.join("vault");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&vault).unwrap();
        fs::write(dir.join("secret.txt"), "shh").unwrap();
        let root = Root::new(&workspace).with_vault(&vault);

        let err = root.resolve("@kb/../secret.txt").unwrap_err();
        assert!(err.contains("outside the workspace root"), "{err}");
        // Interior `..` that stays inside the vault is fine, as in the tree.
        assert!(root.resolve("@kb/a/../b.md").is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    /// A three-character string prefix would swallow this, which is why the
    /// alias is matched on a path component.
    #[test]
    fn a_workspace_path_merely_starting_with_the_alias_is_ordinary() {
        let dir = test_dir("root-alias-lookalike");
        let vault = dir.join("vault");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&vault).unwrap();
        let root = Root::new(&dir).with_vault(&vault);

        let resolved = root.resolve("@kbd/notes.md").unwrap();
        assert_eq!(resolved, normalize(&dir.join("@kbd").join("notes.md")));
        assert_eq!(root.show(&resolved), "@kbd/notes.md");
        fs::remove_dir_all(&dir).ok();
    }

    /// A root with no vault is the shape every existing caller builds, so the
    /// alias has to fail as a *path* rather than resolve to something.
    #[test]
    fn without_a_vault_the_alias_is_refused_by_name() {
        let dir = test_dir("root-no-vault");
        let root = Root::new(&dir);
        assert!(root.vault_path().is_none());

        let err = root.resolve("@kb/anything.md").unwrap_err();
        assert!(err.contains("knowledge vault"), "{err}");
        // And the refusal for an ordinary escape still reads as it always did.
        let err = root.resolve("../../secrets.txt").unwrap_err();
        assert!(err.contains("outside the workspace root"), "{err}");
        assert!(!err.contains("knowledge vault"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    /// Addressing must not depend on what exists: a vault inside a workspace
    /// is reachable both ways and renders one way.
    #[test]
    fn a_vault_nested_in_the_workspace_renders_as_a_workspace_path() {
        let dir = test_dir("root-vault-nested");
        let vault = dir.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let root = Root::new(&dir).with_vault(&vault);

        let by_alias = root.resolve("@kb/note.md").unwrap();
        let by_path = root.resolve("vault/note.md").unwrap();
        assert_eq!(by_alias, by_path);
        // The workspace is checked first, so this is the spelling reported.
        assert_eq!(root.show(&by_alias), "vault/note.md");
        assert_eq!(root.resolve(&root.show(&by_alias)).unwrap(), by_alias);
        fs::remove_dir_all(&dir).ok();
    }
}
