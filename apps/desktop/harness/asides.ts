// Backlogs 225, 226, 228 harness — see asides.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import AsideCard from "../src/lib/AsideCard.svelte";
import AsideView from "../src/lib/AsideView.svelte";
import Sidebar from "../src/lib/Sidebar.svelte";
import { app, draftAside, setAsideUnsent } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
const what = q.get("what") ?? "card";
const lines = Number(q.get("lines") ?? "0");
const hover = q.get("hover") ?? "";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;

app.activeSessionId = "chat-a";
app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code" } as unknown as typeof app.connection;

const text = [
  "Why does it advance only on success?",
  "And why is redoing work cheap?",
  "Is that the rule for partial passes?",
  "Would a unit ever edit it directly?",
  "What happens on a rate limit?",
  "Where is the commit message written?",
].slice(0, lines);

function measure(): void {
  const ta = document.querySelector("textarea");
  if (!ta) return;
  const cs = getComputedStyle(ta);
  cap.textContent =
    `lines=${lines} height=${ta.offsetHeight} scrollHeight=${ta.scrollHeight} clientHeight=${ta.clientHeight} ` +
    `lineHeight=${cs.lineHeight} overflowY=${cs.overflowY} overflowX=${cs.overflowX} ` +
    `scrollWidth=${ta.scrollWidth} clientWidth=${ta.clientWidth} vbar=${ta.offsetWidth - ta.clientWidth - 2}px`;
}

if (what === "card" || what === "view") {
  const quote = { text: "The watermark advances only on success.", role: "assistant" as const, ordinal: 2 };
  const a = draftAside(quote, null)!;
  if (lines > 0) setAsideUnsent(a, text.join("\n"));
  if (what === "card") {
    root.style.width = "440px";
    mount(AsideCard, { target: root, props: { aside: app.asides[0]!, placement: null } });
  } else {
    root.style.width = "900px";
    mount(AsideView, { target: root, props: { session: "chat-a" } });
  }
  flushSync();
  const drag = Number(q.get("drag") ?? "0");
  if (drag !== 0) {
    // A drag on the handle by synthetic pointer events (capture stubbed:
    // a synthetic pointer id cannot be captured).
    localStorage.removeItem("nightloom.aside.height");
    HTMLElement.prototype.setPointerCapture = () => {};
    const h = document.querySelector<HTMLElement>("[aria-label='Aside box height']")!;
    const r = h.getBoundingClientRect();
    const fire = (t: string, y: number) =>
      h.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, button: 0, clientX: r.left + 10, clientY: y, pointerId: 1 }));
    fire("pointerdown", r.top + 6);
    fire("pointermove", r.top + 6 + drag);
    fire("pointerup", r.top + 6 + drag);
  }
  setTimeout(() => {
    measure();
    cap.textContent += `  stored=${localStorage.getItem("nightloom.aside.height")}`;
  }, 300);
} else {
  root.className = "sidebar";
  mount(Sidebar, { target: root, props: {} });
  flushSync();
  // Hover, which a snapshot cannot do: every compiled `.new-chat…:hover`
  // rule copied with `:hover` → `.fake-hover`, the class put on one half.
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule && r.selectorText.includes("new-chat") && r.selectorText.includes(":hover")) {
        sheet.insertRule(r.cssText.replaceAll(":hover", ".fake-hover"), sheet.cssRules.length);
      }
    }
  }
  const halves = document.querySelectorAll<HTMLElement>(".new-chat");
  const el = hover === "more" ? halves[1] : hover === "main" ? halves[0] : null;
  el?.classList.add("fake-hover");
  const side = (e: HTMLElement) => {
    const cs = getComputedStyle(e);
    return `L ${cs.borderLeftColor} T ${cs.borderTopColor} R ${cs.borderRightColor} B ${cs.borderBottomColor} z ${cs.zIndex}`;
  };
  cap.textContent = `hover=${hover || "none"}\nmain: ${side(halves[0]!)}\nmore: ${side(halves[1]!)}`;
}
