import composerSrc from "./Composer.svelte?raw";
import { describe, expect, it } from "vitest";
import { FocusThroughLock, boxLocked } from "./boxLock";

describe("365: when the message box locks", () => {
  it("a connect in flight leaves it typeable, even with no connection (a chat switch to the other engine)", () => {
    expect(boxLocked(false, true)).toBe(false);
    expect(boxLocked(true, true)).toBe(false);
    expect(boxLocked(true, false)).toBe(false);
  });
  it("no connection and none coming locks it", () => {
    expect(boxLocked(false, false)).toBe(true);
  });
});

describe("365: the focus across a lock", () => {
  it("comes back when the box had it and it is now nowhere", () => {
    const f = new FocusThroughLock();
    f.locking(true);
    expect(f.unlocked(true)).toBe(true);
  });
  it("is not taken from a field he moved to meanwhile", () => {
    const f = new FocusThroughLock();
    f.locking(true);
    expect(f.unlocked(false)).toBe(false);
  });
  it("is not taken when the box did not have it", () => {
    const f = new FocusThroughLock();
    f.locking(false);
    expect(f.unlocked(true)).toBe(false);
  });
  it("answers once per lock", () => {
    const f = new FocusThroughLock();
    f.locking(true);
    expect(f.unlocked(true)).toBe(true);
    expect(f.unlocked(true)).toBe(false);
  });
});

describe("365: the wiring", () => {
  it("both boxes (plain and formatted) lock by the rule, not by the bare connection", () => {
    expect([...composerSrc.matchAll(/disabled=\{boxIsLocked\}/g)].length).toBe(2);
    expect(composerSrc).toContain("const boxIsLocked = $derived(boxLocked(!!app.connection, app.connecting));");
  });
  it("the composer records the focus before a lock and takes it back after", () => {
    expect(composerSrc).toMatch(/lockFocus\.locking\(!!box && !!document\.activeElement && box\.contains\(document\.activeElement\)\)/);
    expect(composerSrc).toMatch(
      /if \(lockFocus\.unlocked\([^\n]*\)\) \{\n\s*keeper\.focus\(key, ta, false, true\);/,
    );
  });
});
