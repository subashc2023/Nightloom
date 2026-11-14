import { describe, expect, it } from "vitest";
import transcript from "./Transcript.svelte?raw";
import asideView from "./AsideView.svelte?raw";
import asideCard from "./AsideCard.svelte?raw";
import asideTranscript from "./AsideTranscript.svelte?raw";
import source from "./transcriptSource.svelte.ts?raw";
import { KIND_GUARDS, TRANSCRIPT_FEATURES, TRANSCRIPT_PIECES, featureTable } from "./transcriptFeatures";

/**
 * Item 674: an aside is drawn by the chat's own transcript, and whatever
 * the two do not share is classified in one list.
 */
describe("674: one transcript for the chat and its asides", () => {
  it("an aside's thread is the chat's Transcript, given a source", () => {
    expect(asideTranscript).toMatch(/<Transcript \{source\} \{lead\}>/);
    // The wrapper draws no message itself.
    expect(asideTranscript).not.toMatch(/AssistantMessage|UserBubble/);
    for (const frame of [asideView, asideCard]) {
      expect(frame).toMatch(/<AsideTranscript\b/);
      expect(frame).not.toMatch(/import AssistantMessage|import UserBubble/);
      // AsideThread is Classic's alone (blocker 1989).
      const at = frame.indexOf("<AsideThread");
      expect(at).toBeGreaterThan(-1);
      expect(frame.lastIndexOf("classic()", at)).toBeGreaterThan(-1);
    }
    expect(asideView).toMatch(/frame="full"/);
    expect(asideCard).toMatch(/frame="compact"/);
  });

  it("the transcript reads what it draws from its source, never the open chat's events directly", () => {
    const script = transcript.slice(0, transcript.indexOf("</script>"));
    expect(script).toMatch(/const evs = \$derived\(src\.events\);/);
    expect(script).toMatch(/const liveNow = \$derived\(src\.live\);/);
    expect(script).toMatch(/const approvalsNow = \$derived\(src\.approvals\);/);
    expect(script).toMatch(/const sessionKey = \$derived\(src\.scrollKey\);/);
    expect(script).toMatch(/const src = \$derived<TranscriptSource>\(source \?\? \(chat !== undefined \? paneSource\(chat\) : chatSource\(\)\)\)/);
    for (const k of ["events", "live", "approvals", "locked", "scrollKey", "foldChat", "runFrom", "actions"]) expect(source).toContain(`${k}:`);
  });

  it("every branch on the source's kind is counted — a new one must be classified", () => {
    for (const [guard, n] of Object.entries(KIND_GUARDS)) {
      const found = transcript.match(new RegExp(`(?<![\\w.])${guard.replace(".", "\\.")}\\b`, "g"))?.length ?? 0;
      expect(found, `${guard}: classify the new branch in transcriptFeatures.ts, then update KIND_GUARDS`).toBe(n);
    }
  });

  it("every piece the transcript mounts is classified", () => {
    const mounted = [...transcript.matchAll(/import (\w+)(?:, \{[^}]*\})? from "\.\/\w+\.svelte";/g)].map((m) => m[1]!);
    expect(mounted.length).toBeGreaterThan(10);
    for (const name of mounted) expect(TRANSCRIPT_PIECES, `${name} is mounted by Transcript and not classified`).toHaveProperty(name);
    expect(Object.keys(TRANSCRIPT_PIECES).sort()).toEqual([...new Set(mounted)].sort());
  });

  it("each main-only or pending feature says why, and the table prints", () => {
    for (const [name, w] of Object.entries(TRANSCRIPT_FEATURES)) {
      if (w.in === "mainOnly" || w.in === "pending") expect(w.why.length, name).toBeGreaterThan(10);
    }
    expect(featureTable().split("\n").length).toBe(Object.keys(TRANSCRIPT_FEATURES).length);
  });

  it("674 follow-up: nothing of the chat's transcript is pending for asides any more", () => {
    const pending = Object.entries(TRANSCRIPT_FEATURES).filter(([, w]) => w.in === "pending").map(([n]) => n);
    expect(pending).toEqual([]);
    for (const n of ["per-turn context share bar", "per-reply plan use", "pending bubbles (a message held mid-answer)", "usage-limit pause card", "drop files on the transcript"])
      expect(TRANSCRIPT_FEATURES[n], n).toEqual({ in: "shared" });
    // Each rides the source, read by Transcript with no kind guard.
    for (const k of ["src.sizes", "src.planUse", "src.queue", "src.limit", "src.dropKey"]) expect(transcript, k).toContain(k);
  });

  it("an aside has the chat's ground, rail and jump-down: none is guarded by kind, only by the compact frame", () => {
    expect(transcript).toMatch(/\{#if !compact\}<canvas class="dot-field"/);
    expect(transcript).toMatch(/const showNav = \$derived\(!compact && /);
    const jump = transcript.slice(transcript.indexOf('class="jump-down"') - 200, transcript.indexOf('class="jump-down"'));
    expect(jump).not.toMatch(/#if/);
  });
});
