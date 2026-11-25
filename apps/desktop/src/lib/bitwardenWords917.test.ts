/*
 * Item 917 (his "yeah bitwarden redesign is good", 2026-11-23): each Bitwarden section's heading says what the part
 * is (none reads as a switch — "Always allowed" did), and each empty state says what it is and how to use it.
 */
import { describe, expect, it } from "vitest";
import settings from "./SettingsModal.svelte?raw";
import touch from "./BitwardenTouch.svelte?raw";
import prearm from "./BitwardenPreArm.svelte?raw";
import { bitwardenSummary, CONTROLS } from "./settings/subscriptionPane";

describe("Bitwarden settings words (item 917)", () => {
  it("headings name the part, not a setting", () => {
    for (const h of ["Secrets given without asking", "Unlocking with Touch ID", "Secrets for an away run"]) {
      expect(settings).toContain(`{#snippet label()}<span>${h}</span>{/snippet}`);
    }
    expect(settings).toContain('Bitwarden is {bwSession ? "unlocked" : "locked"} for Nightloom');
    expect(settings).not.toContain("<span>Always allowed</span>");
    expect(settings).not.toContain('Session {bwSession ? "held" : "not held"}');
  });
  it("empty states say what each part is and how it fills", () => {
    expect(settings).toContain("Each rule here gives one Bitwarden secret to one command without showing its card");
    expect(settings).toContain("<b>Always for this command</b> adds the rule");
    expect(touch).toContain("Not set up. Type the master password once; after that one Touch ID press unlocks Bitwarden");
    expect(prearm).toContain("Nothing to pre-arm yet. Before an overnight or away run");
  });
  it("the group's summary and the search index use the same words, old names still find them", () => {
    expect(bitwardenSummary(0, false)).toBe("nothing given without asking · locked");
    expect(bitwardenSummary(1, true)).toBe("1 secret given without asking · unlocked");
    expect(bitwardenSummary(3, false)).toBe("3 secrets given without asking · locked");
    const always = CONTROLS.find((r) => r.id === "bitwarden-always")!;
    expect(always.label).toBe("Secrets given without asking");
    expect(always.terms).toContain("always allowed");
  });
});
