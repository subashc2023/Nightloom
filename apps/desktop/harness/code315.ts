// Item 315 harness — see code315.html. ?s= one of:
//   py | cpp | java | prose   paste that snippet into the box (the textarea)
//   relabel                   paste py, then pick C++ on the block's label
//   undo                      paste py, then ⌘Z once
//   typed                     type a ```py fence by hand
//   send                      paste py and press Send; the caption is what Send handed the backend
//   format                    the formatted box (item 276): paste java, ?n=1 then ⌘Z once
//   bubble                    the sent message: three fenced blocks and prose in his bubble
// ?pal=A|B|C|D: the palette.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft } from "../src/lib/drafts.svelte";

const q = new URLSearchParams(location.search);
const s = q.get("s") ?? "py";
const n = Number(q.get("n") ?? "1");
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};
const yieldNow = () =>
  new Promise<void>((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => r();
    c.port2.postMessage(0);
  });
const settle = async (k = 30) => {
  for (let i = 0; i < k; i++) await yieldNow();
};

const PY = `def fib(n: int) -> int:
    """Return the n-th Fibonacci number."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a`;
const CPP = `#include <iostream>
#include <vector>

int main() {
    std::vector<int> xs{3, 1, 2};
    for (const auto& x : xs) std::cout << x << "\\n";
    return 0;
}`;
const JAVA = `public class Greeter {
    private final String name;

    public Greeter(String name) { this.name = name; }

    public static void main(String[] args) {
        System.out.println(new Greeter("world").greet());
    }

    String greet() { return "Hello, " + name + "!"; }
}`;
const PROSE = `The runner advances its watermark only on success, so a failed unit is redone rather than skipped.
That makes redoing work cheap and skipping it impossible, which is the whole point of the design.`;
const SNIP: Record<string, string> = { py: PY, cpp: CPP, java: JAVA, prose: PROSE };

// The Tauri bridge, faked; Send's command is recorded.
let sent: { cmd: string; text: string } | null = null;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "send_agent" || cmd === "send") sent = { cmd, text: String(args?.text ?? "") };
    return null;
  },
  transformCallback: () => 0,
};

const box = (): HTMLElement =>
  composerFormat.on ? document.querySelector<HTMLElement>(".composer .cm-content")! : document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
const draft = () => readDraft("chat-a").text;

function paste(text: string): void {
  const el = box();
  el.focus();
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  if (!ev.defaultPrevented) {
    if (el instanceof HTMLTextAreaElement) {
      el.setRangeText(text, el.selectionStart, el.selectionEnd, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else document.execCommand("insertText", false, text);
  }
}
function type(text: string): void {
  const el = box() as HTMLTextAreaElement;
  el.focus();
  document.execCommand("insertText", false, text);
}
/** ⌘Z as the box gets it (off the Mac's menu: on the Mac the Edit menu's Undo reaches the same code). */
function undoOnce(): void {
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, bubbles: true, cancelable: true }));
}
const show = (t: string) => JSON.stringify(t.length > 160 ? t.slice(0, 160) + "…" : t);
const fenceLines = (t: string) => t.split("\n").filter((l) => /^(```|~~~)/.test(l)).join(" | ") || "(no fence)";

async function composer(): Promise<void> {
  composerFormat.on = s === "format";
  app.activeSessionId = "chat-a";
  app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  await settle();
  const intro = "Can you review this?\n";
  box().focus();
  type(intro);
  await settle();
  if (s === "typed") {
    type("```py\nfor i in range(3):\n    print(f\"line {i}\")  # typed by hand\n```");
    await settle();
    say(`typed: fences ${fenceLines(draft())}; labels=${document.querySelectorAll(".code-lang, .cm-ccodelang").length}`);
    return;
  }
  const raw = SNIP[s] ?? (s === "format" ? JAVA : PY);
  paste(raw);
  await settle();
  const after = draft();
  const m = /```(\w*)\n([\s\S]*?)\n```/.exec(after);
  say(`pasted ${s === "format" ? "java into the formatted box" : s}: fences ${fenceLines(after)}; body is the paste exactly=${m ? m[2] === raw : "n/a"}; labels=${[...document.querySelectorAll<HTMLSelectElement>(".code-lang, .cm-ccodelang")].map((x) => x.value).join(",") || "none"}`);
  if (s === "relabel") {
    const sel = document.querySelector<HTMLSelectElement>(".code-lang")!;
    sel.value = "cpp";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    const now = draft();
    say(`picked C++ on the label: fences ${fenceLines(now)}; only the info string changed=${now === after.replace("```python", "```cpp")}`);
  }
  if (s === "undo" || (s === "format" && q.has("n"))) {
    for (let i = 0; i < n; i++) {
      undoOnce();
      await settle();
      const t = draft();
      say(`⌘Z ${i + 1}: box=${show(t)}; ${t === intro + raw ? "the raw paste, no fence" : t === intro ? "the paste gone" : "fences " + fenceLines(t)}`);
    }
  }
  if (s === "send") {
    const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent?.trim() === "Send");
    b?.click();
    await settle(200);
    say(`Send handed the backend (${sent?.cmd ?? "nothing"}):\n${sent?.text ?? ""}`);
  }
}

async function bubble(): Promise<void> {
  const text = `Three snippets — which is fastest?\n\`\`\`python\n${PY}\n\`\`\`\n\`\`\`cpp\n${CPP}\n\`\`\`\n\`\`\`java\n${JAVA}\n\`\`\`\n> earlier you said the Java one allocates\nThat was about the greeting, right?`;
  const { default: UserBubble } = await import("../src/lib/UserBubble.svelte");
  const root = document.getElementById("root")!;
  root.style.height = "auto";
  root.style.alignItems = "flex-end";
  root.style.padding = "16px";
  root.style.boxSizing = "border-box";
  root.style.setProperty("--user-bubble-max", "640px");
  mount(UserBubble, { target: root, props: { text } });
  flushSync();
  await settle();
  const blocks = [...document.querySelectorAll(".user-code")];
  say(`bubble: ${blocks.length} code blocks, labels ${blocks.map((b) => b.querySelector(".user-code-lang")?.textContent).join(", ")}; coloured runs ${document.querySelectorAll(".user-code [class*=hljs-]").length}; quotes ${document.querySelectorAll(".user-quote").length}; palette ${document.documentElement.dataset.palette ?? "A"}`);
}

void (s === "bubble" ? bubble() : composer()).catch((e) => say(`error: ${String(e)}`));
