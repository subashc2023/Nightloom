/*
 * Item 993g (blocker 2359): a phone becomes allowed to send only by his Allow click in the Mac's window. This is the
 * call-site half of that rule (the listener's half is the Rust test `a_phone_is_allowed_only_by_the_macs_own_command`):
 * the `phone_key_allow` command has one binding and that binding one caller, the Allow button's component; nothing the
 * phone or the listener can drive (the phone page, the window's remote handlers) names it; and in Rust `Keys::allow`
 * has one caller outside tests, the window's command. The subject is who names the command, so the source is read.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

describe("993g: enrollment cannot complete without the Mac window's command", () => {
  const src = join(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|svelte)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
    });
  const all = files(src).map((p) => [p.slice(src.length + 1), readFileSync(p, "utf8")] as const);

  it("the window calls phone_key_allow from the Allow button's component only", () => {
    // The command's one binding, and that binding's one caller.
    expect(all.filter(([, t]) => t.includes('invoke("phone_key_allow"')).map(([p]) => p)).toEqual(["lib/api.ts"]);
    expect(all.filter(([, t]) => /\bphoneKeyAllow\b/.test(t)).map(([p]) => p).sort()).toEqual(["lib/PhoneKeys.svelte", "lib/api.ts"]);
  });

  it("nothing the phone or the listener can drive reaches it: not the phone page, not the window's remote handlers", () => {
    const driven = all.filter(([p]) => p.startsWith("remote/") || p === "lib/remoteHandlers.ts");
    expect(driven.length).toBeGreaterThan(10);
    for (const [p, t] of driven) expect(/phone_key_allow|\bphoneKeyAllow\b|phone_key_revoke|\bphoneKeyRevoke\b/.test(t), p).toBe(false);
  });

  it("the Rust side has one caller of Keys::allow outside tests: the window's command", () => {
    const root = join(src, "..", "..", "..");
    const rust = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return n === "target" ? [] : statSync(p).isDirectory() ? rust(p) : n.endsWith(".rs") ? [p] : [];
      });
    const callers: string[] = [];
    for (const p of [...rust(join(root, "crates")), ...rust(join(root, "apps", "desktop", "src-tauri", "src"))]) {
      // Code before a file's test module (test modules sit at the end of a file here).
      const code = readFileSync(p, "utf8").split(/^#\[cfg\(test\)\]/m)[0];
      for (const line of code.split("\n")) if (/\.allow\(&/.test(line) && !line.trim().startsWith("//")) callers.push(`${p.slice(root.length + 1)}: ${line.trim()}`);
    }
    expect(callers).toEqual(["apps/desktop/src-tauri/src/remote.rs: phone_keys().allow(&id, &code, chrono::Utc::now())?;"]);
  });
});
