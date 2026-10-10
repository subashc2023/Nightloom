// Item 276 harness — see composer276.html.
import "../src/app.css";
import "katex/dist/katex.min.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, flushSync } from "svelte";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import LiveBox from "../src/lib/LiveBox.svelte";
import { liveSpans, setFocused } from "../src/lib/composerEditor";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const group = q.get("g") ?? "text";
const cursorIn = q.get("cursor") === "in";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;

const TEXT: [string, string][] = [
  ["headings 1–6", "# Heading one\n## Heading two\n### Heading three\n#### Heading four\n##### Heading five\n###### Heading six"],
  ["heading first and last line", "# Plan\nThe body line between two headings.\n## Next"],
  ["not headings", "#hashtag and C# and #1 stay text\n#"],
  ["bold / italic / underscore", "**bold** then *italic* then _also italic_ then ***both*** done"],
  ["not emphasis", "snake_case_names and 2*3*4 and a*b*c stay text"],
  ["strike + code", "~~struck~~ and `inline code` and **bold with `code`**"],
  ["quote line", "> a quoted passage he replied to\nand his answer under it"],
  ["fenced code", "Run this:\n```sh\necho $HOME and $PATH\nexport A=$x$y\n```\nthen tell me"],
  ["not math: money and shell", "between $5 and $10, $ ls -la, a lone $ here"],
  ["not math: escaped / code / shell", "escaped \\$5\\$ and `$x$` and $HOME/bin:$PATH and echo $USER$HOST"],
  ["unclosed $$ while typing", "the estimate is $$\\hat{p} = \\frac{x}{n}"],
  ["mixed paragraph", "If **n** is large, the estimate $\\hat{p}$ is close to *p* — see\n### Why\nthe bound $P(|\\hat{p}-p|>\\epsilon) \\le 2e^{-2n\\epsilon^2}$."],
];

const MATH: [string, string][] = [
  ["his example", "$$\\hat{p}$$"],
  ["inline", "the square $x^2$ and the root $\\sqrt{2}$ inline with text"],
  ["display alone", "$$\\int_0^1 f(x)\\,dx$$"],
  ["display multi-line", "Then:\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\nwhich is the answer."],
  ["frac / sum / text / mathbb", "$\\frac{a}{b}$, $\\sum_{i=1}^n x_i$, $\\text{rate} = 3$, $x \\in \\mathbb{R}$"],
  ["matrix", "$$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$$"],
  ["left/right", "$\\left( \\frac{1}{2} \\right)^n$ shrinks"],
  ["aligned", "$$\\begin{aligned} a &= b + c \\\\ d &= e - f \\end{aligned}$$"],
  ["very long equation", "$$f(x) = a_0 + a_1 x + a_2 x^2 + a_3 x^3 + a_4 x^4 + a_5 x^5 + a_6 x^6 + a_7 x^7 + a_8 x^8 + a_9 x^9 + a_{10} x^{10} + a_{11} x^{11} + a_{12} x^{12} + a_{13} x^{13} + a_{14} x^{14} + a_{15} x^{15} + a_{16} x^{16}$$"],
  ["long inline", "a line with $a_0 + a_1 x + a_2 x^2 + a_3 x^3 + a_4 x^4 + a_5 x^5 + a_6 x^6 + a_7 x^7 + a_8 x^8$ inside running words that wrap"],
  ["tall inline (nested fractions)", "a tall one $\\frac{1}{1+\\frac{1}{1+\\frac{1}{x}}}$ mid-line, and the next line\nkeeps its spacing"],
  ["$$ inline among words", "so $$E = mc^2$$ holds here"],
  ["invalid LaTeX", "broken $\\frac{1}$ stays readable, and $$\\begin{pmatrix} 1 & 2$$ too"],
];

// ?g=play: one box wired as the composer wires it (Enter "sends", the
// text kept in a store), for driving by hand; state on window.__play.
if (group === "play") {
  const play = { text: "", sent: [] as string[], keys: [] as string[] };
  (window as unknown as { __play: typeof play }).__play = play;
  const card = document.createElement("div");
  card.className = "card";
  const wrap = document.createElement("div");
  wrap.className = "ta-wrap";
  card.appendChild(wrap);
  root.appendChild(card);
  const props = $state({ value: "" });
  mount(LiveBox, {
    target: wrap,
    props: {
      get value() {
        return props.value;
      },
      placeholder: "Message…",
      onchange: (v: string) => {
        props.value = v;
        play.text = v;
      },
      onkeydown: (e: KeyboardEvent) => {
        play.keys.push(e.key);
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          play.sent.push(props.value);
          props.value = "";
          play.text = "";
        }
      },
    },
  });
}
const cases = group === "math" ? MATH : group === "play" ? [] : TEXT;
if (group === "play") {
  flushSync();
  const v = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
  (window as unknown as { __view: EditorView }).__view = v;
}
const lines: string[] = [];

for (const [name, text] of cases) {
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = `${name}${cursorIn ? " · cursor in" : ""}`;
  const card = document.createElement("div");
  card.className = "card";
  const wrap = document.createElement("div");
  wrap.className = "ta-wrap";
  card.appendChild(wrap);
  root.append(label, card);
  mount(LiveBox, { target: wrap, props: { value: text, onchange: () => {}, placeholder: "Message…" } });
  flushSync();
  const dom = wrap.querySelector<HTMLElement>(".cm-editor")!;
  const view = EditorView.findFromDOM(dom)!;
  if (cursorIn) {
    const first = liveSpans(view.state).find((s) => s.kind !== "quote");
    const at = first ? first.from + Math.min(2, first.to - first.from) : view.state.doc.length;
    // Each box counts as focused (only one can hold the real focus).
    view.dispatch({ selection: EditorSelection.cursor(at), effects: setFocused.of(true) });
  } else {
    // Park the caret where no span touches it (the end of a line that ends
    // in plain text, else the first such position), unfocused.
    const spans = liveSpans(view.state).filter((s) => s.kind !== "quote");
    const free = (p: number) => !spans.some((s) => p >= s.from && p <= s.to);
    let at = -1;
    for (let p = view.state.doc.length; p >= 0; p--) if (free(p)) { at = p; break; }
    if (at >= 0) view.dispatch({ selection: EditorSelection.cursor(at) });
  }
  lines.push(name);
}

setTimeout(() => {
  const out: string[] = [];
  document.querySelectorAll<HTMLElement>(".cm-editor").forEach((d, i) => {
    const sc = d.querySelector<HTMLElement>(".cm-scroller")!;
    const view = EditorView.findFromDOM(d)!;
    const open = liveSpans(view.state).filter((s) => s.open).map((s) => s.kind);
    const blocks = Array.from(d.querySelectorAll<HTMLElement>(".cm-nmath-block"));
    const bw = blocks.map((b) => `${b.scrollWidth}/${b.clientWidth}`).join(",");
    out.push(
      `${String(i + 1).padStart(2)} ${(lines[i] ?? "play").slice(0, 30).padEnd(30)} box ${sc.scrollWidth}/${sc.clientWidth} h ${d.offsetHeight}` +
        (bw ? ` block ${bw}` : "") +
        (open.length ? ` open:${open.join("+")}` : ""),
    );
    if (sc.scrollHeight > sc.clientHeight) {
      const r = sc.getBoundingClientRect();
      const stick = Array.from(sc.querySelectorAll<HTMLElement>("*"))
        .filter((e) => { const b = e.getBoundingClientRect(); return b.height > 0 && (b.bottom > r.bottom + 0.5 || b.top < r.top - 0.5); })
        .slice(-3)
        .map((e) => { const b = e.getBoundingClientRect(); return `${e.className || e.tagName}[${Math.round(b.top - r.top)}..${Math.round(b.bottom - r.top)}]`; });
      out.push(`   v-overflow ${sc.scrollHeight}/${sc.clientHeight}: ${stick.join(" ")}`);
    }
  });
  cap.textContent += out.join("\n");
}, 400);
