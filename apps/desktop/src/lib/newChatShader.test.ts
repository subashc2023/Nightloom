import { describe, expect, it } from "vitest";
import { GROUND_MENU, groundWanted } from "./newChatGround";
import { DEFAULT_GROUND, parseGround } from "./newChatGroundPick.svelte";
import { RADAR_BLIP_CELLS, RADAR_SPOKES, RADAR_TICKS, isShaderLook, shaderColours, shaderSource, shaderWanted } from "./newChatShader";

describe("item 640: Horizon and Radar", () => {
  it("offers Horizon, Radar and Default (today's Weft) in Settings, Horizon the default", () => {
    expect(GROUND_MENU.map((g) => g.id)).toEqual(["horizon", "radar", "weft"]);
    expect(GROUND_MENU.map((g) => g.name)).toEqual(["Horizon", "Radar", "Default"]);
    expect(DEFAULT_GROUND).toBe("horizon");
  });
  it("reads every stored look back, the dropped ones too", () => {
    for (const v of ["horizon", "radar", "weft", "dots", "ripple", "drift", "aurora"]) expect(parseGround(v)).toBe(v);
    expect(parseGround(null)).toBe("horizon");
    expect(parseGround("holo")).toBe("horizon");
  });
  it("keeps the 2D canvas off for the shader looks (the dot tile stays under them)", () => {
    const tile = "radial-gradient(circle, red 1px, transparent 1.2px)";
    expect(groundWanted("horizon", tile, false)).toBe(false);
    expect(groundWanted("radar", tile, false)).toBe(false);
    expect(groundWanted("weft", tile, false)).toBe(true);
  });
  it("runs the shader only for its looks, with the lit ground on unless asked always", () => {
    const tile = "radial-gradient(circle, red 1px, transparent 1.2px)";
    expect(isShaderLook("horizon")).toBe(true);
    expect(isShaderLook("weft")).toBe(false);
    expect(shaderWanted("horizon", tile)).toBe(true);
    expect(shaderWanted("radar", " none")).toBe(false); // Calm
    expect(shaderWanted("radar", "none", true)).toBe(true); // a Settings card
    expect(shaderWanted("weft", tile)).toBe(false);
  });
  it("draws Jarvis in the design page's colours exactly", () => {
    const c = shaderColours([134, 216, 247], [255, 180, 84]);
    expect(c.cyan.map((v) => +v.toFixed(3))).toEqual([0.31, 0.88, 0.9]);
    expect(c.deep.map((v) => +v.toFixed(3))).toEqual([0.16, 0.34, 1]);
    expect(c.amb.map((v) => +v.toFixed(3))).toEqual([1, 0.706, 0.329]);
    // another palette's signal shifts the hue, never past 1
    const b = shaderColours([127, 179, 240], [211, 139, 93]);
    for (const v of [...b.cyan, ...b.deep, ...b.lil, ...b.dawn]) expect(v).toBeLessThanOrEqual(1);
  });
  it("divides Radar's turn into whole parts, so nothing is cut where the angle wraps", () => {
    for (const n of [RADAR_SPOKES, RADAR_TICKS, RADAR_BLIP_CELLS]) expect(Number.isInteger(n)).toBe(true);
    const src = shaderSource("radar");
    expect(src).toContain(`${(Math.PI * 2) / RADAR_SPOKES}`);
    expect(src).toContain(`mod(id.x, ${RADAR_BLIP_CELLS}.0)`);
    expect(shaderSource("horizon")).toContain("sin(a * 26.0");
  });
});
