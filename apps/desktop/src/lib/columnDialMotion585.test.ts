import { describe, expect, it } from "vitest";
import motionSrc from "./DialMotion.svelte?raw";
import { asOneFile } from "../test/oneFile";
import rightRailLogicRaw from "./rightRail/logic.svelte.ts?raw";
import railSrcRaw from "./RightRail.svelte?raw";
const railSrc = asOneFile(railSrcRaw, rightRailLogicRaw);
import welcomeSrc from "./Welcome.svelte?raw";
import classicRailSrcRaw from "./RightRailClassic.svelte?raw";
const classicRailSrc = asOneFile(classicRailSrcRaw, rightRailLogicRaw);

// Item 585: the right column's dial carries a quiet subset of 581's new-chat motion.
describe("the column dial's motion (585)", () => {
  // Item 587 (2026-11-10) widened 585's subset: the gears join, in the column form, and his keys surge it too.
  it("mounts DialMotion behind the column dial, quiet, every layer in its column form, surging while a turn streams or he types", () => {
    expect(railSrc).toContain("const COLUMN_LAYERS = null;");
    expect(railSrc).toMatch(/<DialMotion size=\{104\} pad=\{14\} quiet column layers=\{COLUMN_LAYERS\} plan=\{motionPlan\} streaming=\{live\} typed=\{marks\.length \+ keys\} flowKey=\{stepKey\} gear=\{dv \? drive\.gear : null\} gearKey=\{drive\.n\} \/>/);
    // No project spin-up in the column: a chat switch must not whirl the gears.
    expect(railSrc).not.toMatch(/<DialMotion[^>]*spinKey/);
  });
  it("keeps the new-chat page as it was: the new props default off", () => {
    expect(motionSrc).toContain("quiet = false, streaming = false, layers = null, column = false, gear = null, gearKey = 0 }: Props = $props();");
    expect(welcomeSrc).not.toMatch(/<DialMotion[^>]*(quiet|streaming|layers|column)/);
  });
  it("quiet dims every layer and drops the glow", () => {
    expect(motionSrc).toContain("const dim = (ink.calm ? 0.7 : 1) * (quiet ? 0.6 : 1);");
    expect(motionSrc).toContain("if (ink.glow && !ink.calm && !quiet) {");
  });
  it("leaves Classic's column alone", () => {
    // test-change: item 856 — Classic draws 605's column beside an aside tab
    // now, RightRail's column as it is, its dial's motion included.
    expect(classicRailSrc).toContain("DialMotion");
  });
});
