// Item 276 fix pass — see composer276-steps.html.
import "../src/app.css";
import "katex/dist/katex.min.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { EditorSelection } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { composerState, composerTheme, liveSpans } from "../src/lib/composerEditor";

interface Step {
  label: string;
  doc: string;
  anchor: number;
  head: number;
}
const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;

class Caret extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "fake-caret";
    return el;
  }
}

const steps: Step[] = await (await fetch(`./steps276/${q.get("f")}.json`)).json();
const out: string[] = [];
steps.forEach((s, i) => {
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = `${String(i + 1).padStart(2)}. ${s.label}   ${JSON.stringify(s.doc)} @${s.anchor === s.head ? s.head : `${s.anchor}-${s.head}`}`;
  const card = document.createElement("div");
  card.className = "card";
  const wrap = document.createElement("div");
  wrap.className = "ta-wrap";
  card.appendChild(wrap);
  root.append(label, card);
  const sel = EditorSelection.range(s.anchor, s.head);
  const deco =
    s.anchor === s.head
      ? Decoration.set([Decoration.widget({ widget: new Caret(), side: 1 }).range(s.head)])
      : Decoration.set([Decoration.mark({ class: "fake-sel" }).range(sel.from, sel.to)]);
  const state = composerState(s.doc, [composerTheme, EditorView.lineWrapping, EditorView.decorations.of(deco)], s.head, true);
  const view = new EditorView({ state: state.update({ selection: sel }).state, parent: wrap });
  const open = liveSpans(view.state)
    .filter((x) => x.kind !== "quote")
    .map((x) => `${x.kind}${x.open ? "*" : ""}[${x.from},${x.to}]`);
  out.push(`${String(i + 1).padStart(2)} h ${view.dom.offsetHeight} ${open.join(" ")}`);
});
cap.textContent = out.join("\n");
