import { describe, expect, it } from "vitest";
import { isImeKey } from "./imeKey";
import composerSrc from "./Composer.svelte?raw";
import threadSrc from "./AsideThread.svelte?raw";
import nameSrc from "./AsideNameEdit.svelte?raw";
import subagentSrc from "./SubagentView.svelte?raw";
import remoteSrc from "../remote/Remote.svelte?raw";
import liveBoxSrc from "./LiveBox.svelte?raw";

// Item 322: Enter that commits an input method's composition never sends.
describe("isImeKey", () => {
  it("is the input method's key while composing (Chromium order)", () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
  });
  it("is the input method's key on WebKit's commit-Enter (compositionend first, keyCode 229)", () => {
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });
  it("is an ordinary key otherwise — the second Enter sends", () => {
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKey({})).toBe(false);
  });
});

// Every Enter-to-send box reads the guard before its Enter branch. A source
// check, since these are Svelte components the node test run does not mount
// (the WebKit harness `harness/ime322.ts` drives the composer itself).
describe("Enter-to-send boxes guard on the input method", () => {
  it("the composer (and the aside box, which is the composer) returns before any Enter branch", () => {
    const s = composerSrc;
    const fn = s.slice(s.indexOf("function onkeydown(e: KeyboardEvent)"));
    const guard = fn.indexOf("if (isImeKey(e)) return;");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(fn.indexOf('e.key === "Enter"'));
  });
  it("the aside's edit-question box", () => {
    const fn = threadSrc.slice(threadSrc.indexOf("function editKeys"));
    expect(fn.indexOf("isImeKey(e)")).toBeGreaterThan(0);
    expect(fn.indexOf("isImeKey(e)")).toBeLessThan(fn.indexOf('e.key === "Enter"'));
  });
  it("the aside's name box", () => {
    expect(nameSrc.indexOf("isImeKey(e)")).toBeGreaterThan(0);
    expect(nameSrc.indexOf("isImeKey(e)")).toBeLessThan(nameSrc.indexOf('e.key === "Enter"'));
  });
  it("the subagent's ask box and the phone page's box", () => {
    expect(subagentSrc).toMatch(/e\.key === "Enter" && !e\.shiftKey && !isImeKey\(e\)/);
    expect(remoteSrc).toMatch(/e\.key === "Enter" && !e\.shiftKey && !isImeKey\(e\)/);
  });
  it("the formatted editor (LiveBox) leaves mid-composition keys to the input method", () => {
    expect(liveBoxSrc).toMatch(/if \(e\.isComposing \|\| e\.keyCode === 229\) return false;/);
  });
});
