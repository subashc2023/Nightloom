import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import AssistantMessage from "./AssistantMessage.svelte";
import remoteSrc from "../remote/Remote.svelte?raw";
import type { Segment } from "./state.svelte";

// Nightshift item 343: a `send_file` result is drawn under the reply as an
// attachment chip — name, caption, size, Open, Save, Reveal — on either
// engine's name for the tool, and not for a refused call.

const ID = "0123456789abcdef0123456789abcdef";
const content = `Sent "report.pdf" (2.0 KB) to the user.\nnightloom-sent-file: {"id":"${ID}","name":"report.pdf","size":2048,"path":"/s/${ID}/report.pdf","caption":"the Q3 report"}`;
const seg = (name: string, is_error = false): Segment => ({
  kind: "tool",
  call: { id: `c-${name}-${is_error}`, name, input: { path: "report.pdf" }, result: { content: is_error ? "outside" : content, is_error } },
});

describe("the sent file's chip", () => {
  it("draws the chip under a recorded reply on the Claude Code engine's name", () => {
    const { body } = render(AssistantMessage, {
      // No text segment: the markdown sanitizer needs a DOM this suite has not.
      props: { segs: [seg("mcp__nightloom__send_file")] },
    });
    expect(body).toContain('class="cards sent-files');
    expect(body).toContain("report.pdf");
    expect(body).toContain("the Q3 report");
    expect(body).toContain("2.0 KB");
    for (const b of [">Open<", ">Save<", ">Reveal<"]) expect(body).toContain(b);
  });

  it("draws it on the API engine's name, and nothing for a refusal", () => {
    expect(render(AssistantMessage, { props: { segs: [seg("send_file")] } }).body).toContain("sent-files");
    expect(render(AssistantMessage, { props: { segs: [seg("send_file", true)] } }).body).not.toContain("sent-files");
  });

  it("the phone page draws the chip on recorded and live replies", () => {
    expect(remoteSrc).toMatch(/\{@render sentChips\(sentOf\(r\.tools\)\)\}/);
    expect(remoteSrc).toMatch(/\{@render sentChips\(sentOf\(live\.tools\)\)\}/);
    expect(remoteSrc).toMatch(/await client\.sentFile\(f\)/);
  });
});
