import { describe, expect, it } from "vitest";
import composerRaw from "./Composer.svelte?raw";
import railRaw from "./RightRail.svelte?raw";
import railClassicRaw from "./RightRailClassic.svelte?raw";
import railLogicRaw from "./rightRail/logic.svelte.ts?raw";
import handoffRaw from "./manualHandoff.svelte.ts?raw";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// A CSS file's ?raw comes back empty under vitest; read it from disk.
const controlsCss = readFileSync(fileURLToPath(new URL("../filGo.css", import.meta.url)), "utf8");

/**
 * Item 926 (his ask 2026-11-23: "need an animation on the wrap up now
 * button kinda like the send now button animation"): every hand-off-now
 * control carries Send's motion — the scan on hover, the charge on the
 * press, the edge trace while it sends — and its words fly into the thread
 * as a typed send's do.
 */
describe("926: Wrap up now moves as Send does", () => {
  it("every Wrap up now button in the composer is a .fil-go with Send's scan and edge, lit while sending, launched from itself", () => {
    const buttons = composerRaw.split("\n").filter((l) => /<button[^\n]*sendWrapUpNow\(/.test(l));
    expect(buttons.length).toBe(4);
    for (const b of buttons) {
      expect(b).toContain("fil-go");
      expect(b).toContain("class:sending={wrapSending}");
      expect(b).toContain("sendWrapUpNow(e.currentTarget)");
      expect(b).toContain('<span class="fil-scan" aria-hidden="true"></span><span class="fil-edge" aria-hidden="true"></span>');
    }
  });

  it("/handoff from the box flies from the box", () => {
    const at = composerRaw.indexOf("isHandoffCommand(text)");
    const body = composerRaw.slice(at, at + 600);
    expect(body).toContain("const box = boxElement(ta);");
    expect(body).toContain("await sendWrapUpNow(box);");
  });

  it("the right rail's Hand off now carries the same look (Jarvis) and the flight (both themes)", () => {
    expect(railRaw).toMatch(/class="hand fil-go"/);
    expect(railRaw).toContain("class:sending={T.handing && !app.busy}");
    expect(railRaw).toContain("T.handOff(e.currentTarget)");
    expect(railClassicRaw).toContain("T.handOff(e.currentTarget)");
    expect(railLogicRaw).toContain("void handOffNow(undefined, from)");
  });

  it("the one hand-off path launches the send motion from the control, after any aside picker", () => {
    const cb = handoffRaw.slice(handoffRaw.indexOf("beginWrapUp(chat);"));
    expect(cb.slice(0, 400)).toContain('if (from?.isConnected) launch("chat", from);');
  });

  it("the look is Send's keyframes, Jarvis only, still under reduced motion", () => {
    const block = controlsCss.slice(controlsCss.indexOf("Item 926"));
    expect(block).toContain("animation: fil-scan 0.6s ease-out 1 both;");
    expect(block).toContain("animation: fil-charge 0.32s ease-out 1;");
    expect(block).toContain("animation: fil-edge 1s linear infinite;");
    expect(block).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*\.fil-go\.sending > \.fil-edge/);
    expect(block).toContain(':where(:root:not([data-layout="classic"])) .fil-go {');
  });
});
