// Item 716 part 3: Settings → Reply text runs a looping demo of each look, side by side, with the
// real motion (replyMotion), its look pinned per card; the demo's marks stay AssistantMessage's.
import { describe, expect, it } from "vitest";
import demoSrc from "./ReplyLookDemo.svelte?raw";
import messageSrc from "./AssistantMessage.svelte?raw";
import motionSrc from "./replyMotion.ts?raw";
import settingsSrc from "./SettingsModal.svelte?raw";

/** The declarations of the first rule whose selector ends with `sel` (comments dropped, whitespace folded). */
function decls(src: string, sel: string): string {
  const css = src.slice(src.indexOf("<style>")).replace(/\/\*[\s\S]*?\*\//g, "");
  const i = css.indexOf(sel + " {");
  expect(i, sel).toBeGreaterThan(-1);
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  return body.replace(/\s+/g, " ").trim();
}

describe("Reply text demo (item 716)", () => {
  it("draws the shuttle and the word rise exactly as a reply does", () => {
    expect(decls(demoSrc, ".rl-demo :global(.rm-shuttle)")).toBe(decls(messageSrc, ".assistant :global(.rm-shuttle)"));
    const rise = (s: string) => s.slice(s.indexOf("animation:")).replace(/\s+/g, " ");
    expect(rise(decls(demoSrc, ".rl-demo :global(.rm-w)"))).toBe(rise(decls(messageSrc, ".assistant :global(.rm-w)")));
  });
  it("uses the real motion, its look pinned on the root", () => {
    expect(demoSrc).toContain("use:replyMotion={streaming}");
    expect(demoSrc).toContain("data-reply-look={look}");
    expect(motionSrc).toMatch(/const pinned = root\.dataset\.replyLook;\s*look = pinned \? parseReplyLook\(pinned\) : currentReplyLook\(\);/);
  });
  it("stands still under Reduce motion: the whole reply, no loop", () => {
    expect(demoSrc).toMatch(/const still = motionOff\(\);/);
    expect(demoSrc).toMatch(/shown = \$state\(still \? SAMPLE : ""\)/);
    expect(demoSrc).toMatch(/if \(!still\) \{/);
  });
  it("sits in each Reply text card, the two side by side", () => {
    const sec = settingsSrc.slice(settingsSrc.indexOf('aria-label="Reply text"'), settingsSrc.indexOf("<!-- End item 617. -->"));
    expect(sec).toContain("<ReplyLookDemo look={l.id} />");
  });
});
