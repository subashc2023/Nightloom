// Item 837 harness — see math837.html.
import "../src/app.css";
import "katex/dist/katex.min.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount } from "svelte";
import UserBubble from "../src/lib/UserBubble.svelte";
import UserBubbleClassic from "../src/lib/UserBubbleClassic.svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import AssistantMessageClassic from "../src/lib/AssistantMessageClassic.svelte";
import { renderMarkdown } from "../src/lib/markdown";
import { codePasteLanguage, fenced } from "../src/lib/codeDetect";
import { findTypedMath } from "../src/lib/typedMath";

const q = new URLSearchParams(location.hash.slice(1));
const which = q.get("case") ?? "831";
const classic = q.get("layout") === "classic";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
const Bubble = classic ? UserBubbleClassic : UserBubble;
const Reply = classic ? AssistantMessageClassic : AssistantMessage;
const say = (s: string) => (cap.textContent += (cap.textContent ? "\n" : "") + s);
const bubble = (text: string) => {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;justify-content:flex-end;margin:0 0 16px";
  root.appendChild(row);
  mount(Bubble, { target: row, props: { text } });
};

export const CASES = {
  "831":
    'honestly especially with uniform distributions im getting confused w like width values, mean values, middle values, height values, like idk. thats what i feel like fucke dup 6b.\nwill the exam use this terminology "where it applies"?\n\nU1. (theta - 3) is the length. height is 1/(theta - 3)\nU2. E(X) is (theta+3)/2. estimator is (theta+3)/2 = $$\\bar{X}$$.\n(11+3)/2 = X_bar -> 7.',
  "834": "how can i check that answer is in legal range if i dont have any numbers\n\nM2.\n$L(\\lambda) = \\Sigma \\lambda^{2} x e^{- \\lambda x}$\nl(lambda) = Sigma(ln(\\lambda^{2} x e^{- \\lambda x})",
  "835":
    "M4 cuz shaped like exam.\nl(theta) = n (3 ln (x) + - n(x/theta) + ln(1)*n - ln(6) + 4ln(theta)\nderivative:\n0 = nx/theta^2 + 4/theta\n* theta ^2\nnx + $4 \\cdot \\theta = 0$\ntheta = -nx/4",
  "836":
    "Term by term:\n\n| term | what the sum does | why |\n|---|---|---|\n| $-\\ln 6$ | $n$ × it: $-4n\\ln\\theta$, $-n\\ln 6$ | the same thing added $n$ times |\n| $-\\frac{x}{\\theta}$ | pull the something out, and $\\sum x_i = T$: $-\\frac{T}{\\theta}$ | $\\frac{x-1}{\\theta}$ would not split |\n\nSo the log-likelihood is $\\ell(\\theta) = -4n\\ln\\theta - \\frac{T}{\\theta}$.",
  sigma: "## Variance $\\sigma^2$, the sum $\\Sigma$, $\\delta$ and $\\Delta$, $\\omega$ and $\\Omega$\n\nIn the text: $\\sigma$ $\\Sigma$ $\\delta$ $\\Delta$ $\\omega$ $\\Omega$.",
  dollars: "it costs $5 and $10 a month, or $1,200 total. my path is $HOME/bin:$PATH and the answer is $x^2 + y^2 = r^2$ ok\nalso \\(a_i\\) and \\[\\int_0^1 x\\,dx\\] and \\sigma{1, 2, 4} bare.",
} as const;

if (which === "835") {
  const pasted = CASES["835"];
  const lang = codePasteLanguage(pasted, "", 0);
  say(`paste read as: ${lang ? `code (${lang}) — fenced into the box` : "plain text — pasted as it is"}`);
  bubble(lang ? fenced(pasted, lang, "", "") : pasted);
} else if (which === "836") {
  const full = CASES["836"];
  const at = full.indexOf("$\\frac{x-1}{\\") + "$\\frac{x-1}{\\".length;
  const cut = Number(q.get("cut") ?? at);
  say(`streaming, ${cut} of ${full.length} characters arrived; the text ends: ${JSON.stringify(full.slice(Math.max(0, cut - 24), cut))}`);
  mount(Reply, { target: root, props: { segs: [{ kind: "text", text: full.slice(0, cut) }], streaming: true, headed: false, since: Date.now() } as never });
} else if (which === "838") {
  // Item 838: a selection across inline and display formulas (the desktop's `installMathSelection`).
  const d = document.createElement("div");
  d.className = "markdown";
  d.innerHTML = renderMarkdown("The likelihood is $L(\\theta) = \\prod_{i} f(x_i \\mid \\theta)$ and its log is\n\n$$\\ell(\\theta) = -4n\\ln\\theta - \\frac{T}{\\theta}$$\n\nso $\\hat\\theta = \\frac{T}{4n}$ maximises it.");
  root.appendChild(d);
  void import("../src/lib/mathCopy").then((m) => {
    (m as { installMathSelection?: () => void }).installMathSelection?.();
    const r = document.createRange();
    r.selectNodeContents(d);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    say("the whole reply selected");
  });
} else if (which === "sigma") {
  const d = document.createElement("div");
  d.className = "ns-prose";
  d.innerHTML = renderMarkdown(CASES.sigma);
  root.appendChild(d);
  say("a Nightshift page (.ns-prose): its h2 is drawn in capitals");
} else {
  const text = CASES[which as "831" | "834" | "dollars"];
  bubble(text);
  if (which === "834")
    for (const line of ["L(lambda) = Sigma lambda^2 x e^(-lambda x)", "l(lambda) = Sigma(ln(\\lambda^{2} x e^{- \\lambda x})", "Sigma(x) vs sigma(x)", "Delta x = 3, delta x = 3"])
      say(`box offers for ${JSON.stringify(line)}: ${findTypedMath(line).map((s) => `${s.src} → ${s.tex}`).join("  |  ") || "(nothing)"}`);
}
setTimeout(() => {
  const raw = [...root.querySelectorAll(".user-text, .markdown, .ns-prose")].map((e) => (e as HTMLElement).innerText).join("\n");
  const half = raw.match(/\$[^$\n]*\\[a-z]*[{\\]?$|\\frac|\\bar|\\lambda|\\cdot|\\theta/gm) ?? [];
  say(`formulas drawn: ${root.querySelectorAll(".katex").length}; raw LaTeX left in view: ${half.length ? half.join(" ") : "none"}; code blocks: ${root.querySelectorAll(".user-code, pre").length}`);
  document.title = "ready";
}, 600);
