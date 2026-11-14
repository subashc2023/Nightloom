// Item 644: the message box by the chat's model family — the pure family test, the id the box follows, and where
// Composer and the stylesheet carry it.
import { describe, expect, it } from "vitest";
import { composerModelId, modelFamily } from "./modelFamily";
import composerSrc from "./Composer.svelte?raw";
import mainSrc from "../main.ts?raw";
// vitest empties CSS imports (composerRow618b.test.ts), so the rules are read from disk; the module name is built so
// the type check (no Node types in this app) does not resolve it.
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const css = fs.readFileSync(new URL("../modelFamily.css", import.meta.url), "utf8");

describe("modelFamily", () => {
  it("reads Opus from aliases, full ids, provider ids and display names", () => {
    for (const id of [
      "opus",
      "Opus",
      "opus[1m]",
      "opusplan",
      "claude-opus-5-5",
      "claude-opus-5-5[1m]",
      "claude-opus-4-1-20250805",
      "claude-3-opus-20240229",
      "anthropic/claude-opus-4.1",
      "us.anthropic.claude-opus-4-1-20250805-v1:0",
      "claude-opus-4-1@20250805",
      "Opus 5.5",
      " opus ",
    ])
      expect(modelFamily(id), id).toBe("opus");
  });

  it("reads Fable the same ways", () => {
    for (const id of ["fable", "FABLE", "fable[1m]", "claude-fable-5-2", "claude-fable-5-2-20261101", "anthropic/claude-fable-5.1", "Fable 5.2"])
      expect(modelFamily(id), id).toBe("fable");
  });

  it("puts every other model, the CLI's default and nothing at all in other", () => {
    for (const id of [
      "sonnet",
      "haiku",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "anthropic/claude-sonnet-5",
      "deepseek/deepseek-v4-flash",
      "gpt-5",
      "gemini-3-pro",
      "magnum-opusx",
      "fabled-7b",
      "default",
      "",
      null,
      undefined,
    ])
      expect(modelFamily(id), String(id)).toBe("other");
  });
});

describe("composerModelId", () => {
  const base = { agentMode: true, agentModel: "opus", model: "claude-sonnet-5", connected: "claude-haiku-4-5" };
  it("follows the alias picked on Claude Code, never the connection's resolved id", () => {
    expect(composerModelId(base)).toBe("opus");
    expect(composerModelId({ ...base, agentModel: "claude-fable-5-2" })).toBe("claude-fable-5-2");
    expect(composerModelId({ ...base, agentModel: "" })).toBe(""); // default: not resolved → today's box
  });
  it("follows the connection's model on the provider engine, else the draft's", () => {
    expect(composerModelId({ ...base, agentMode: false })).toBe("claude-haiku-4-5");
    expect(composerModelId({ ...base, agentMode: false, connected: null })).toBe("claude-sonnet-5");
  });
  it("follows an aside's own pick, else the chat's", () => {
    expect(composerModelId({ ...base, asideModel: "fable" })).toBe("fable");
    expect(composerModelId({ ...base, asideModel: "" })).toBe("opus");
    expect(composerModelId({ ...base, asideModel: null })).toBe("opus");
  });
});

describe("the composer carries the family", () => {
  it("stamps data-model-family on its root from modelFamily(composerModelId(…)), with the aside's pick", () => {
    expect(composerSrc).toMatch(/import \{ composerModelId, modelFamily \} from "\.\/modelFamily";/);
    expect(composerSrc).toMatch(/const family = \$derived\(\s*modelFamily\(\s*composerModelId\(\{/);
    expect(composerSrc).toMatch(/asideModel: aside\?\.model \?\? null/);
    // On the root, beside the row choice, so the card, its brackets and the coil can all read it.
    expect(composerSrc).toMatch(/data-composer-row=\{composerRow\.value\}\s*\n\s*data-model-family=\{family\}/);
  });

  it("is imported last, after the cache look, so it wins the card's ties", () => {
    const i = mainSrc.indexOf('import "./cacheLook.css";');
    const j = mainSrc.indexOf('import "./modelFamily.css";');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
  });

  it("draws only Opus and Fable, every rule behind the non-Classic layout", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.trim()).filter((r) => r.includes("{"));
    for (const r of rules) {
      const sel = r.slice(0, r.indexOf("{"));
      if (sel.trim() === ":root") continue;
      expect(sel, sel).toContain('html:not([data-layout="classic"])');
      expect(sel).not.toContain('"other"');
    }
    expect(css).toContain("--fable: #b9a3ff;");
    expect(css).toContain("--opus: #c97a52;");
    // Round 1's Lilac glass numbers, scaled by k (1 for Fable).
    for (const n of ["calc(10% * var(--c644-k))", "calc(7% * var(--c644-k))", "calc(30% * var(--c644-k))", "calc(26% * var(--c644-k))"])
      expect(css).toContain(n);
    // Opus scales the shares by one constant (3 since 9696642: the design page's Copper, his pick).
    expect(css).toMatch(/--c644-opus-k: [\d.]+;/);
    expect(css).toMatch(/--c644-k: var\(--c644-opus-k\);/);
    // Send, the Edge line (::after) and the row's buttons are not touched.
    expect(rules.join("}")).not.toMatch(/\.send|::after|\.ns-btn|\.bottom-/);
  });
});
