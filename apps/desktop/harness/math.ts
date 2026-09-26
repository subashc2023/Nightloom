// Backlog 236 harness — see math.html.
import "../src/app.css";
import { renderMarkdown } from "../src/lib/markdown";

const q = new URLSearchParams(location.search);
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;

// His equation (item 236's screenshot, cut off there at "represen…"; the
// rest reconstructed), and a short one that fits.
const reply = [
  "The measure, stated once:",
  "",
  "$$\\text{complexity}_R(\\text{feature}) = \\text{shortest function in the learner's hypothesis space that computes the feature from representation } R$$",
  "",
  "and a short one that fits:",
  "",
  "$$E = mc^2$$",
  "",
  "The next paragraph starts here.",
].join("\n");

for (const [name, w] of [
  ["aside card", 440],
  ["aside tab", 760],
  ["wide pane", 900],
] as const) {
  const f = document.createElement("div");
  f.className = "frame";
  f.style.width = `${w}px`;
  f.innerHTML = `<div class="label">${name} · ${w}px</div><div class="markdown">${renderMarkdown(reply)}</div>`;
  root.appendChild(f);
}

if (q.get("hover") === "1") {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule && r.selectorText.includes("katex-display") && r.selectorText.includes(":hover")) {
        sheet.insertRule(r.cssText.replaceAll(":hover", ".fake-hover"), sheet.cssRules.length);
      }
    }
  }
  document.querySelectorAll(".katex-display").forEach((e) => e.classList.add("fake-hover"));
}

setTimeout(() => {
  const lines: string[] = [];
  document.querySelectorAll<HTMLElement>(".frame").forEach((f) => {
    const name = f.querySelector(".label")!.textContent;
    f.querySelectorAll<HTMLElement>(".katex-display").forEach((d, i) => {
      const cs = getComputedStyle(d);
      lines.push(
        `${name} eq${i + 1}: scrollW ${d.scrollWidth} clientW ${d.clientWidth} (overflows ${d.scrollWidth > d.clientWidth}) · ` +
          `scrollH ${d.scrollHeight} clientH ${d.clientHeight} (v-overflow ${d.scrollHeight > d.clientHeight}) · ` +
          `hbar ${d.offsetHeight - d.clientHeight}px vbar ${d.offsetWidth - d.clientWidth}px · ox ${cs.overflowX} oy ${cs.overflowY}`,
      );
    });
  });
  cap.textContent = lines.join("\n");
}, 400);
