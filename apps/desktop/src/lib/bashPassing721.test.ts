// Item 721: a running Bash row's passing text is headed by the command's first line, in Jarvis and Classic.
import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import AssistantMessage from "./AssistantMessage.svelte";
import AssistantMessageClassic from "./AssistantMessageClassic.svelte";
import passingSrc from "./BashPassing.svelte?raw";
import type { Segment } from "./state.svelte";
import { commandHead, endPassing, setPassing } from "./bashOutput.svelte";

const bash = (id: string, command: string): Segment =>
  ({ kind: "tool", call: { id, name: "Bash", input: { command }, result: null } }) as Segment;
const props = (segs: Segment[]) => ({ segs, streaming: true, headed: false, since: Date.now(), motion: "combo" as const });

describe("the command's head (721)", () => {
  it("is line 1 only, marked when more follow; nothing for no command", () => {
    expect(commandHead({ command: "cargo test -p nightloom-service -j 2" })).toBe("$ cargo test -p nightloom-service -j 2");
    expect(commandHead({ command: "\n  cd x &&\\\n  npm run check\nnpx vitest run\n" })).toBe("$ cd x &&\\ …");
    expect(commandHead({ command: "a\r\nb" })).toBe("$ a …");
    expect(commandHead({ command: "  \n " })).toBeNull();
    expect(commandHead({})).toBeNull();
    expect(commandHead(null)).toBeNull();
  });

  it("sits above the output, unfaded and cut with an ellipsis; the output keeps 656's mask", () => {
    expect(passingSrc.indexOf('class="cmd"')).toBeLessThan(passingSrc.indexOf('class="out"'));
    const cmd = passingSrc.slice(passingSrc.indexOf("  .cmd {"), passingSrc.indexOf("  .out {"));
    expect(cmd).toContain("text-overflow: ellipsis;");
    expect(cmd).toContain("var(--mono");
    expect(cmd).not.toContain("mask");
    const out = passingSrc.slice(passingSrc.indexOf("  .out {"), passingSrc.indexOf("  .pl {"));
    expect(out).toContain("mask: linear-gradient(180deg, transparent, #000 55%);");
  });

  for (const [name, C] of [["Jarvis", AssistantMessage], ["Classic", AssistantMessageClassic]] as const) {
    it(`a running Bash row draws it in ${name}`, () => {
      setPassing("h1", ["Compiling nightloom-core"]);
      const { body } = render(C as typeof AssistantMessage, { props: props([bash("h1", "cargo build\ncargo test")]) });
      expect(body).toContain('data-testid="bash-passing-cmd"');
      expect(body).toContain("$ cargo build …");
      expect(body).not.toContain("$ cargo test");
      expect(body.indexOf("$ cargo build")).toBeLessThan(body.indexOf("Compiling nightloom-core"));
      endPassing("h1");
    });
    it(`a command that prints nothing shows nothing in ${name}`, () => {
      const { body } = render(C as typeof AssistantMessage, { props: props([bash("h2", "sleep 5")]) });
      expect(body).not.toContain('data-testid="bash-passing"');
    });
  }
});
