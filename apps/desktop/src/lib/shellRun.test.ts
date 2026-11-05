import { describe, expect, it } from "vitest";
import { marked } from "marked";
import {
  RUN_OUTPUT_CAP,
  RunCapture,
  cutOutput,
  endsInOpenFence,
  isShellClass,
  parseRan,
  ranMessage,
  routeRun,
  runStatus,
  runTabTitle,
  stripAnsi,
} from "./shellRun";

describe("503: which blocks get Run", () => {
  it("takes bash, sh, shell and zsh and nothing else", () => {
    for (const l of ["bash", "sh", "shell", "zsh", "BASH"]) expect(isShellClass(`language-${l}`)).toBe(true);
    for (const l of ["python", "text", "bashful", ""]) expect(isShellClass(l ? `language-${l}` : "")).toBe(false);
  });
  it("the fence's language survives marked; a bare fence has none", () => {
    expect(marked.parse("```bash\nls\n```", { async: false, gfm: true })).toContain('class="language-bash"');
    expect(marked.parse("```\nls\n```", { async: false, gfm: true })).not.toContain("language-");
  });
  it("names a closed fence, an open one, a nested one and a quoted one", () => {
    expect(endsInOpenFence("no code")).toBe(false);
    expect(endsInOpenFence("```bash\nls\n```\n")).toBe(false);
    expect(endsInOpenFence("```bash\nls")).toBe(true);
    expect(endsInOpenFence("```bash\nls\n```\ntext\n```sh\nrm")).toBe(true);
    expect(endsInOpenFence("````md\n```\nstill in\n```\n")).toBe(true);
    expect(endsInOpenFence("> ```bash\n> ls\n> ```\n")).toBe(false);
    expect(endsInOpenFence("1. ```bash\n   ls\n   ```\n")).toBe(false);
    expect(endsInOpenFence("~~~\n```\n~~~\n")).toBe(false);
    // Inline code on its own line is no opener.
    expect(endsInOpenFence("```a``` b")).toBe(false);
  });
  it("while streaming, a closer that is the last thing received is not trusted", () => {
    expect(endsInOpenFence("```bash\nls\n```", true)).toBe(true);
    expect(endsInOpenFence("```bash\nls\n```\n", true)).toBe(false);
    expect(endsInOpenFence("```bash\nls\n```", false)).toBe(false);
  });
});

describe("503: a tab's name", () => {
  it("is the first line that does something, cut", () => {
    expect(runTabTitle("# set up\n\nnpm test\nnpm run build")).toBe("npm test");
    expect(runTabTitle("x".repeat(50))).toBe(`${"x".repeat(31)}…`);
  });
});

describe("503: ANSI stripped", () => {
  it("takes colours, cursor moves, titles and charset switches", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m \x1b[1;32mgreen\x1b[m")).toBe("red green");
    expect(stripAnsi("\x1b]0;title\x07after")).toBe("after");
    expect(stripAnsi("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
    expect(stripAnsi("\x1b(Babc\x1b[?2004h")).toBe("abc");
  });
  it("a carriage return overwrites its line; CRLF is a line end", () => {
    expect(stripAnsi("10%\r50%\r100%\ndone\r\n")).toBe("100%\ndone\n");
  });
  it("a backspace takes the character before; control bytes go", () => {
    expect(stripAnsi("ab\bc\x07")).toBe("ac");
  });
  it("keeps tabs and text outside ASCII", () => {
    expect(stripAnsi("a\tb é ✓")).toBe("a\tb é ✓");
  });
});

describe("503: output over the cap", () => {
  it("is left alone under it", () => {
    expect(cutOutput("short", 100)).toBe("short");
  });
  it("keeps a head and a longer tail, marked", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const cut = cutOutput(text, 300);
    expect(cut.startsWith("line 0\n")).toBe(true);
    expect(cut.endsWith("line 999")).toBe(true);
    expect(cut).toMatch(/\[… [\d,]+ characters cut …\]/);
    expect(cut.length).toBeLessThan(360);
    const [head, tail] = cut.split(/\n\[…[^\n]*\n/);
    expect(tail.length).toBeGreaterThan(head.length);
  });
});

describe("503: what a run printed", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it("decodes a character split across two reads", () => {
    const c = new RunCapture();
    const b = bytes("é");
    c.add(b.slice(0, 1));
    c.add(b.slice(1));
    expect(c.take()).toBe("é");
  });
  it("starts over after a take", () => {
    const c = new RunCapture();
    c.add(bytes("one"));
    expect(c.take()).toBe("one");
    expect(c.empty).toBe(true);
    c.add(bytes("two"));
    expect(c.take()).toBe("two");
  });
  it("a never-ending printer holds a bounded amount and keeps both ends", () => {
    const c = new RunCapture(1000);
    c.add(bytes("FIRST\n"));
    for (let i = 0; i < 100_000; i++) c.add(bytes(`line ${i}\n`));
    c.add(bytes("LAST\n"));
    const out = c.take(600);
    expect(out.startsWith("FIRST\n")).toBe(true);
    expect(out.endsWith("LAST")).toBe(true);
    expect(out).toContain("characters cut");
    expect(out.length).toBeLessThan(700);
  });
  it("the default cap is the one named", () => {
    expect(RUN_OUTPUT_CAP).toBe(30_000);
  });
});

describe("503: the message", () => {
  it("reads back for the card, whatever the output holds", () => {
    const m = { command: "npm test\nnpm run build", status: "exit 1", output: "<terminal-output>\n```\nboom" };
    expect(parseRan(ranMessage(m))).toEqual(m);
  });
  it("leaves his own words alone", () => {
    expect(parseRan("Ran in terminal — and it was fine")).toBeNull();
    expect(parseRan("plain")).toBeNull();
  });
  it("carries empty output", () => {
    expect(parseRan(ranMessage({ command: "true", status: "exit 0", output: "" }))?.output).toBe("");
  });
  it("says how it stands", () => {
    expect(runStatus({ exit: { code: 0, signal: null } })).toBe("exit 0");
    expect(runStatus({ exit: { code: null, signal: "SIGTERM" } })).toBe("ended by SIGTERM");
    expect(runStatus({ stopped: true, exit: { code: 130, signal: null } })).toBe("stopped by you");
    expect(runStatus({ soFar: true })).toBe("still running, output so far");
  });
});

describe("503: where the message goes", () => {
  const base = { chat: "a", exists: true, aside: false, open: "a", busy: false, runningElsewhere: false, engine: "claude-code" };
  it("the chat on screen, idle: sent", () => {
    expect(routeRun(base).kind).toBe("send");
  });
  it("the chat on screen, mid-turn: queued into the turn", () => {
    expect(routeRun({ ...base, busy: true }).kind).toBe("inject");
  });
  it("switched away: its own chat in the background, never the open one", () => {
    expect(routeRun({ ...base, open: "b" }).kind).toBe("background");
    expect(routeRun({ ...base, open: "b", busy: true }).kind).toBe("background");
  });
  it("switched away from a chat that is running: held for its turn's end", () => {
    expect(routeRun({ ...base, open: "b", runningElsewhere: true }).kind).toBe("queue");
  });
  it("the API engine off screen: its queue, one provider turn at a time", () => {
    expect(routeRun({ ...base, open: "b", engine: "api" }).kind).toBe("queue");
  });
  it("deleted: nowhere; no id: nowhere", () => {
    expect(routeRun({ ...base, exists: false }).kind).toBe("gone");
    expect(routeRun({ ...base, chat: null }).kind).toBe("gone");
  });
  it("an aside still open takes its own", () => {
    expect(routeRun({ ...base, aside: true }).kind).toBe("aside");
  });
});
