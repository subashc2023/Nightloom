import { describe, expect, it } from "vitest";
import settingsSrc from "./SettingsModal.svelte?raw";
import searchIndexSrc from "./settings/searchIndex.ts?raw";
import { canAsk, isRead, sourceButton, sourceStatusWords, sourcesSummary, type HomeSource } from "./homeSources";

const row = (id: HomeSource["id"], status: HomeSource["status"], on = true): HomeSource => ({
  id,
  name: { messages: "Messages", contacts: "Contacts", reminders: "Reminders", calendar: "Calendar app" }[id],
  status,
  on,
  why: "",
  settings_url: "",
});

describe("Home's sources on this Mac (item 808)", () => {
  it("names every status in plain words", () => {
    expect(sourceStatusWords("allowed")).toBe("Allowed");
    expect(sourceStatusWords("not_asked")).toBe("Not allowed yet");
    expect(sourceStatusWords("denied")).toBe("Turned down");
    expect(sourceStatusWords("write_only")).toBe("Add only");
    expect(sourceStatusWords("not_on_this_mac")).toBe("Not on this Mac");
  });

  it("offers Allow until macOS has answered, then System Settings; Messages is always Allow", () => {
    expect(sourceButton(row("contacts", "not_asked"))).toBe("Allow");
    expect(sourceButton(row("contacts", "denied"))).toBe("Open System Settings");
    expect(sourceButton(row("calendar", "write_only"))).toBe("Open System Settings");
    expect(sourceButton(row("messages", "not_asked"))).toBe("Allow");
    expect(sourceButton(row("messages", "denied"))).toBe("Allow");
    expect(sourceButton(row("reminders", "allowed"))).toBeNull();
    expect(sourceButton(row("reminders", "not_on_this_mac"))).toBeNull();
  });

  it("lets the phone ask only for what is not allowed and is on this Mac", () => {
    expect(canAsk(row("contacts", "not_asked"))).toBe(true);
    expect(canAsk(row("contacts", "denied"))).toBe(true);
    expect(canAsk(row("contacts", "allowed"))).toBe(false);
    expect(canAsk(row("contacts", "not_on_this_mac"))).toBe(false);
  });

  it("sums up what the scan reads", () => {
    expect(sourcesSummary([])).toBe("");
    expect(sourcesSummary([row("messages", "not_on_this_mac"), row("contacts", "not_on_this_mac")])).toMatch(/Only the Nightloom app/);
    expect(sourcesSummary([row("messages", "not_asked"), row("contacts", "allowed", false)])).toBe("The morning scan reads none of these yet.");
    expect(sourcesSummary([row("messages", "allowed"), row("contacts", "not_asked")])).toBe("The morning scan reads Messages.");
    expect(isRead(row("contacts", "allowed", false))).toBe(false);
    expect(
      sourcesSummary([row("messages", "allowed"), row("contacts", "allowed"), row("reminders", "allowed"), row("calendar", "allowed")]),
    ).toBe("The morning scan reads all four.");
  });
});

// Review of item 872: Home now changes Reminders (and, since 845, mail
// labels, drafts and events) on his tap, so no Settings line may still
// promise that it only reads.
describe("Settings' Home words match what Home can change (item 872)", () => {
  it("never says Home only reads where it can change on a tap", () => {
    for (const text of [settingsSrc, searchIndexSrc]) {
      expect(text).not.toContain("it never adds, changes or sends");
      expect(text).not.toContain("it cannot send, change or delete anything");
    }
    expect(settingsSrc).toContain("it adds a reminder or marks one done when you tap Allow on that one change");
  });
});
