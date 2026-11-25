// Item 980: no new test reads a component's source as text.
//
// 622's reviews measured it: 34.6% of test files import a `.svelte` file
// as text and assert on its characters, so a refactor that keeps behaviour
// breaks them; the AGENTS.md rule from item 866 (2026-11-19) asked new tests
// not to, and 43 of the next 80 did. A sentence did not hold, so this test
// does: every test file that reads `.svelte` source must be in the baseline
// of 2026-11-25 or in `MARKUP_TESTS` with its reason. The fix for a failure
// is the test, not the list: move the logic to a `.ts` module and call it.
import { describe, expect, it } from "vitest";
import { BASELINE, MARKUP_TESTS } from "./sourceTextTests980.allow";

const SELF = "lib/sourceTextTests980.test.ts";

// Every test file's text, keyed by its path under `src/`. The patterns are
// built from pieces so this file's own text never matches them.
const files = import.meta.glob("../**/*.test.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RAW_SVELTE = new RegExp("\\.svelte\\?" + "raw");
const READS_FILE = new RegExp("read" + "FileSync");
const SVELTE_LITERAL = new RegExp("\\.svelte[\"'`]");

/** Whether a test file's text reads `.svelte` source: a `?raw` import of
 * one, or `readFileSync` beside a `.svelte` path. Pure. */
export function readsSvelteSource(text: string): boolean {
  return RAW_SVELTE.test(text) || (READS_FILE.test(text) && SVELTE_LITERAL.test(text));
}

/** A glob key (relative to this file, in `src/lib/`) as a path under `src/`. */
function underSrc(key: string): string {
  if (key.startsWith("./")) return "lib/" + key.slice(2);
  return key.replace(/^\.\.\//, "");
}

describe("item 980: source-text tests", () => {
  it("finds the test files (the glob is not empty)", () => {
    expect(Object.keys(files).length).toBeGreaterThan(100);
  });

  it("tells a source-text test from a behaviour test", () => {
    const q = "?" + "raw";
    expect(readsSvelteSource(`import src from "./Composer.svelte${q}";`)).toBe(true);
    expect(readsSvelteSource(`import src from "./logic.svelte.ts${q}";`)).toBe(false);
    expect(readsSvelteSource(`const t = read` + `FileSync(join(dir, "App.svelte"), "utf8");`)).toBe(true);
    expect(readsSvelteSource(`import { pick } from "./pick";`)).toBe(false);
  });

  it("adds no test file that reads .svelte source beyond the 2026-11-25 baseline", () => {
    const allowed = new Set<string>([...BASELINE, ...Object.keys(MARKUP_TESTS), SELF]);
    const added = Object.entries(files)
      .map(([key, text]) => [underSrc(key), text] as const)
      .filter(([path, text]) => !allowed.has(path) && readsSvelteSource(text))
      .map(([path]) => path)
      .sort();
    expect(
      added,
      "New tests must call the logic in a .ts module, not read a component's source (AGENTS.md, item 980). " +
        "A test about the markup itself goes in MARKUP_TESTS in sourceTextTests980.allow.ts with its reason.",
    ).toEqual([]);
  });

  it("gives every markup exception a reason", () => {
    for (const [path, why] of Object.entries(MARKUP_TESTS)) {
      expect(why.trim().length, path).toBeGreaterThan(10);
    }
  });
});
