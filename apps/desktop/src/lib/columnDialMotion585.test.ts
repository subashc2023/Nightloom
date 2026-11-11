import { describe, expect, it } from "vitest";
import motionSrc from "./DialMotion.svelte?raw";
import railSrc from "./RightRail.svelte?raw";
import welcomeSrc from "./Welcome.svelte?raw";
import classicRailSrc from "./RightRailClassic.svelte?raw";

// Item 585: the right column's dial carries a quiet subset of 581's new-chat motion.
describe("the column dial's motion (585)", () => {
  it("mounts DialMotion behind the column dial, quiet, ring and tick only, surging while a turn streams", () => {
    expect(railSrc).toContain('const COLUMN_LAYERS = ["wave", "hand"];');
    expect(railSrc).toMatch(/<DialMotion size=\{104\} pad=\{14\} quiet layers=\{COLUMN_LAYERS\} streaming=\{live\} typed=\{marks\.length\} \/>/);
    // No project spin-up in the column: a chat switch must not whirl the gears.
    expect(railSrc).not.toMatch(/<DialMotion[^>]*spinKey/);
  });
  it("keeps the new-chat page as it was: the new props default off", () => {
    expect(motionSrc).toContain("quiet = false, streaming = false, layers = null }: Props = $props();");
    expect(welcomeSrc).not.toMatch(/<DialMotion[^>]*(quiet|streaming|layers)/);
  });
  it("quiet dims every layer and drops the glow", () => {
    expect(motionSrc).toContain("const dim = (ink.calm ? 0.7 : 1) * (quiet ? 0.6 : 1);");
    expect(motionSrc).toContain("if (ink.glow && !ink.calm && !quiet) {");
  });
  it("leaves Classic's column alone", () => {
    expect(classicRailSrc).not.toContain("DialMotion");
  });
});
