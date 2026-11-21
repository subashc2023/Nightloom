import { describe, expect, it } from "vitest";
import modernRaw from "./Transcript.svelte?raw";
import classicRaw from "./TranscriptClassic.svelte?raw";
import transcriptLogicRaw from "./transcript/logic.svelte.ts?raw";
import { asOneFile } from "../test/oneFile";
const modern = asOneFile(modernRaw, transcriptLogicRaw);
const classic = asOneFile(classicRaw, transcriptLogicRaw);

/** Item 560: a queued or scheduled message follows the foot like a reply.
 *  The follow effect re-runs only on what it reads; this guards that it
 *  reads the open chat's queue and its scheduled message, in both layouts. */
describe("follow the foot on a queued message (item 560)", () => {
  for (const [file, src] of [["Transcript.svelte", modern], ["TranscriptClassic.svelte", classic]]) {
    it(`${file}'s follow effect reads the queue and the scheduled message`, () => {
      const at = src.indexOf("followStep(pinned, presence.away, atBottom())");
      const start = src.lastIndexOf("$effect(() => {", at);
      const effect = src.slice(start, at);
      expect(effect).toContain("readDraft(key).queue.length");
      expect(effect).toContain("scheduledFor(key)");
    });
  }
});
