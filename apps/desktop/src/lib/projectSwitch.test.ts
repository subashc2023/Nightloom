import { describe, expect, it } from "vitest";
import stateSrc from "./state.svelte.ts?raw";
import welcomeSrc from "./Welcome.svelte?raw";
import coverSrc from "./SwitchCover.svelte?raw";
import stripSrc from "./TabStrip.svelte?raw";
import classicStripSrc from "./TabStripClassic.svelte?raw";

describe("a project switch covers the new-chat page (item 598)", () => {
  const body = stateSrc.slice(stateSrc.indexOf("export async function useProject("), stateSrc.indexOf("export async function openProjectFolder("));
  it("useProject raises the cover after the project opens and always lowers it", () => {
    const on = body.indexOf("projectSwitch.on = true;");
    expect(on).toBeGreaterThan(body.indexOf("app.project = await api.openProject(id);"));
    expect(on).toBeLessThan(body.indexOf("app.activeSessionId = null;"));
    expect(body).toMatch(/\} finally \{\s*projectSwitch\.on = false;\s*\}\s*\}\n/);
    expect(body.indexOf("await restoreTabs(")).toBeLessThan(body.indexOf("} finally {"));
  });
  it("covers the page over it, never instead of it, and Classic gets no dial", () => {
    expect(welcomeSrc).toMatch(/\{#if projectSwitch\.on\}[\s\S]*<SwitchCover classic=\{classic\(\)\} \/>/);
    expect(coverSrc).toContain("{#if gear && !classic}");
  });
});

describe("tabs share one width (item 603)", () => {
  it("the Filament strip's tabs grow from one basis; Classic's strip is untouched", () => {
    expect(stripSrc).toMatch(/\.tab \{[^}]*flex: 1 1 0;/);
    expect(classicStripSrc).not.toContain("TabFreeze");
  });
});
