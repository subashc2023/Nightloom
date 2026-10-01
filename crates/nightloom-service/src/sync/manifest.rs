//! The manifest the Mac sends first (nightshift item 268, step 3): every
//! file of the snapshot by its path under the mirror, its size and its
//! SHA-256, so the server can answer with only the paths it lacks or holds
//! an older copy of.
//!
//! Paths are `/`-separated and relative to the mirror root; [`safe_rel`]
//! is the one check every side runs before a path becomes a file name.
//! SHA-256 is written out here (FIPS 180-4) rather than taken from a new
//! dependency: the crate has none that exposes it, and the function is
//! short, fixed and checked against the standard's own test vectors below.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// One file of the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Relative to the mirror root, `/`-separated.
    pub path: String,
    pub size: u64,
    /// Lowercase hex.
    pub sha256: String,
}

/// The whole snapshot, sent before any file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub entries: Vec<Entry>,
}

impl Manifest {
    /// By path, for a diff.
    pub fn by_path(&self) -> BTreeMap<&str, &Entry> {
        self.entries.iter().map(|e| (e.path.as_str(), e)).collect()
    }
}

/// The paths of `local` that `remote` lacks or holds a different copy of,
/// in `local`'s order — what the Mac must send.
pub fn changed(local: &Manifest, remote: &Manifest) -> Vec<String> {
    let have = remote.by_path();
    local
        .entries
        .iter()
        .filter(|e| {
            have.get(e.path.as_str())
                .is_none_or(|r| r.size != e.size || r.sha256 != e.sha256)
        })
        .map(|e| e.path.clone())
        .collect()
}

/// The paths `remote` holds that `local` no longer names — a chat deleted
/// on the Mac, a project no longer marked: the server's copies to drop.
pub fn gone(local: &Manifest, remote: &Manifest) -> Vec<String> {
    let want = local.by_path();
    remote
        .entries
        .iter()
        .filter(|e| !want.contains_key(e.path.as_str()))
        .map(|e| e.path.clone())
        .collect()
}

/// Whether `rel` may name a file under a root: relative, `/`-separated,
/// no empty, `.` or `..` segment, no backslash or NUL, and no segment that
/// starts with a dot (the server's own index files are dotfiles). Every
/// path from the other side passes this before it is joined to anything.
pub fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel.len() <= 1024
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && !rel.contains('\0')
        && rel
            .split('/')
            .all(|seg| !seg.is_empty() && !seg.starts_with('.'))
}

/// `root` joined with a [`safe_rel`] path, or `None` when it is not one.
pub fn join(root: &Path, rel: &str) -> Option<PathBuf> {
    safe_rel(rel).then(|| rel.split('/').fold(root.to_path_buf(), |p, s| p.join(s)))
}

/// SHA-256 of a byte string, lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.hex()
}

/// SHA-256 and length of a file, read in pieces.
pub fn hash_file(path: &Path) -> io::Result<(u64, String)> {
    let mut file = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut len = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        len += n as u64;
        h.update(&buf[..n]);
    }
    Ok((len, h.hex()))
}

/// Hashes by (path, size, mtime), so a push every 15 minutes re-reads only
/// the files that changed — a chat log that grew, not the hundred that did
/// not. In memory for the life of the app; the first push reads everything.
#[derive(Debug, Default)]
pub struct HashCache {
    seen: BTreeMap<PathBuf, (u64, Option<SystemTime>, String)>,
}

impl HashCache {
    /// The file's size and hash, from the cache when its size and mtime
    /// are unchanged.
    pub fn hash(&mut self, path: &Path) -> io::Result<(u64, String)> {
        let meta = fs::metadata(path)?;
        let size = meta.len();
        let mtime = meta.modified().ok();
        if let Some((s, m, h)) = self.seen.get(path)
            && *s == size
            && *m == mtime
            && mtime.is_some()
        {
            return Ok((size, h.clone()));
        }
        let (len, hex) = hash_file(path)?;
        self.seen
            .insert(path.to_path_buf(), (len, mtime, hex.clone()));
        Ok((len, hex))
    }
}

/// A small SHA-256 (FIPS 180-4), streaming.
pub struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total: u64,
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: [0; 64],
            buf_len: 0,
            total: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.compress(&block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.total.wrapping_mul(8);
        let mut pad = vec![0x80u8];
        let rem = (self.total as usize + 1) % 64;
        let zeros = if rem <= 56 { 56 - rem } else { 120 - rem };
        pad.extend(std::iter::repeat_n(0u8, zeros));
        pad.extend_from_slice(&bits.to_be_bytes());
        // `update` would count the padding into `total`; it is already read.
        let total = self.total;
        self.update(&pad);
        self.total = total;
        debug_assert_eq!(self.buf_len, 0);
        let mut out = [0u8; 32];
        for (i, w) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
        }
        out
    }

    pub fn hex(self) -> String {
        self.finish().iter().map(|b| format!("{b:02x}")).collect()
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for (i, chunk) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*chunk);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (s, v) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FIPS 180-4's own vectors, plus a long input fed in odd pieces.
    #[test]
    fn sha256_matches_the_standard_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        let million = vec![b'a'; 1_000_000];
        assert_eq!(
            sha256_hex(&million),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
        let mut h = Sha256::new();
        for piece in million.chunks(37) {
            h.update(piece);
        }
        assert_eq!(h.hex(), sha256_hex(&million));
        // Lengths around the padding boundary.
        for n in 54..=66 {
            let data = vec![b'x'; n];
            let mut a = Sha256::new();
            a.update(&data[..n / 2]);
            a.update(&data[n / 2..]);
            assert_eq!(a.hex(), sha256_hex(&data), "length {n}");
        }
    }

    fn e(path: &str, size: u64, sha: &str) -> Entry {
        Entry {
            path: path.into(),
            size,
            sha256: sha.into(),
        }
    }

    /// The diff names only what is new or different, and what is gone.
    #[test]
    fn the_diff_names_only_changed_files() {
        let remote = Manifest {
            entries: vec![
                e("AGENTS.md", 3, "aa"),
                e("projects/p/sessions/a.jsonl", 10, "bb"),
                e("projects/p/sessions/old.jsonl", 4, "dd"),
            ],
        };
        let local = Manifest {
            entries: vec![
                e("AGENTS.md", 3, "aa"),
                e("projects/p/sessions/a.jsonl", 12, "bc"),
                e("knowledge/n.md", 1, "cc"),
            ],
        };
        assert_eq!(
            changed(&local, &remote),
            vec!["projects/p/sessions/a.jsonl", "knowledge/n.md"]
        );
        assert_eq!(gone(&local, &remote), vec!["projects/p/sessions/old.jsonl"]);
        assert!(changed(&local, &local).is_empty());
        // The same size with a different hash is a change.
        let same_size = Manifest {
            entries: vec![e("AGENTS.md", 3, "ab")],
        };
        assert_eq!(changed(&same_size, &remote), vec!["AGENTS.md"]);
    }

    #[test]
    fn only_plain_relative_paths_are_safe() {
        for ok in ["AGENTS.md", "knowledge/a/b.md", "claude/-Users-x/s.jsonl"] {
            assert!(safe_rel(ok), "{ok}");
        }
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../b",
            "a//b",
            "a/./b",
            ".index.json",
            "a\\b",
            "projects/p/sessions/.listing.json",
        ] {
            assert!(!safe_rel(bad), "{bad}");
        }
        assert_eq!(
            join(Path::new("/m"), "a/b.md"),
            Some(PathBuf::from("/m/a/b.md"))
        );
        assert_eq!(join(Path::new("/m"), "../b"), None);
    }

    #[test]
    fn the_cache_rehashes_only_a_changed_file() {
        let dir = std::env::temp_dir().join(format!("nl-sync-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x");
        fs::write(&f, "one").unwrap();
        let mut cache = HashCache::default();
        assert_eq!(cache.hash(&f).unwrap(), (3, sha256_hex(b"one")));
        fs::write(&f, "three").unwrap();
        assert_eq!(cache.hash(&f).unwrap(), (5, sha256_hex(b"three")));
        let _ = fs::remove_dir_all(&dir);
    }
}
