// Item 610: the Thinking motion choice sits in the Thinking block card, each
// choice previewing the real trace with its own motion.
import { describe, expect, it } from "vitest";
import settingsSrc from "./SettingsModal.svelte?raw";
import messageSrc from "./AssistantMessage.svelte?raw";
import previewSrc from "./StepMotionPreview.svelte?raw";

describe("the Thinking motion in Settings → Animations", () => {
  it("is inside the Thinking block card, after the arrivals, under 'While it thinks', not a card of its own", () => {
    const card = settingsSrc.indexOf('<span class="t">Thinking block</span>');
    const arrivals = settingsSrc.indexOf('aria-label="Thinking block arrival"');
    const sub = settingsSrc.indexOf(">While it thinks<");
    const group = settingsSrc.indexOf('aria-label="Thinking motion"');
    const end = settingsSrc.indexOf("</section>", card);
    expect(card).toBeGreaterThan(0);
    expect(arrivals).toBeGreaterThan(card);
    expect(sub).toBeGreaterThan(arrivals);
    expect(group).toBeGreaterThan(sub);
    expect(group).toBeLessThan(end);
    expect(settingsSrc).not.toMatch(/<section class="card f4-only" aria-label="Thinking motion">/);
    expect(settingsSrc.slice(sub, end)).toMatch(/<StepMotionPreview motion=\{m\.id\}/);
  });

  it("previews with the real reply component, its motion its own", () => {
    expect(previewSrc).toMatch(/<AssistantMessage[^>]*streaming=\{true\}[^>]*\{motion\}/);
    expect(messageSrc).toMatch(/data-motion=\{motion \?\? stepMotion\.value\}/);
  });

  it("keys the trace's motion rules on the trace, not on <html>", () => {
    expect(messageSrc).not.toMatch(/:root\[data-step-motion/);
    expect(messageSrc).not.toMatch(/:root:not\(\[data-step-motion/);
    expect(messageSrc).toMatch(/\.trace\[data-motion="weave"\] \.mo-bg/);
    expect(messageSrc).toMatch(/\.trace\[data-motion="quiet"\] \.mo-weft\.k-think/);
  });
});
