// Backlog 304 harness — see jump304.html. The real App, the Tauri backend stubbed (unknown commands answer null).
// A chat of twelve turns, a reply streaming (`app.live`, `app.busy`), the transcript scrolled to the top so the
// jump-to-latest button shows. Then, by `step`:
//   speak  the speaking dots, every animation paused at `t` ms (a frame series is several `t`s)
//   focus  the button focused (the :focus-visible twin of :hover, which a script cannot set), its
//          transitions paused at `m` ms (0–200) — the dots gathering into the ⌄
//   done   the reply ends (`live` and `busy` cleared): the dots settle into the plain ⌄
//   click  the button clicked while still speaking: the view lands at the foot and the button hides
// `reduced=1` copies the page's own `prefers-reduced-motion: reduce` rules in unconditionally (WebKit here
// cannot be told to emulate the setting), so the frame shows what that setting gets.
// The caption reads each dot's scale, the dots' and the ⌄'s opacity, and the button's state.
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
const step = q.get("step") ?? "speak";
const t = Number(q.get("t") ?? "0");
const m = Number(q.get("m") ?? "200");
const cap = document.getElementById("cap")!;
const unknown = new Set<string>();

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const project = {
  id: "p51",
  name: "ICS 51",
  root: "/Users/you/school/ics-51",
  notes_dir: "/Users/you/school/ics-51/.agents/notes",
  chats: 1,
  notes: 0,
  exists: true,
};
const sessions = [{ id: "s1-midterm", title: "Pipelining hazards", mode: "normal", kind: "build", modified: ago(3) }];

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd) => {
  switch (cmd) {
    case "list_sessions":
      return sessions;
    case "list_projects":
      return [project];
    case "list_notes":
    case "providers":
    case "nightshift_projects":
    case "centre_proposals":
    case "centre_dream_commits":
    case "list_threads":
      return [];
    default:
      unknown.add(cmd);
      return null;
  }
};

try {
  localStorage.clear();
} catch {
  // Storage off: nothing to clear.
}
if (q.get("reduced") === "1") {
  // The page's own reduced-motion rules, applied as if the setting were on.
  const copy = () => {
    const out: string[] = [];
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const r of rules)
        if (r instanceof CSSMediaRule && r.conditionText.includes("prefers-reduced-motion: reduce"))
          for (const inner of r.cssRules) out.push(inner.cssText);
    }
    const s = document.createElement("style");
    s.textContent = out.join("\n");
    document.head.appendChild(s);
    return out.length;
  };
  (window as unknown as { __reduce: () => number }).__reduce = copy;
}
document.documentElement.dataset.palette = q.get("p") ?? "A";
mount(App, { target: document.getElementById("app")! });
flushSync();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scaleOf = (el: Element) => {
  const tr = getComputedStyle(el).transform;
  if (!tr || tr === "none") return 1;
  const v = tr.match(/matrix\(([^)]+)\)/)?.[1].split(",").map(Number);
  return v ? Math.hypot(v[0], v[1]) : NaN;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function read(btn: HTMLElement | null): string {
  if (!btn) return "button: absent";
  const dots = btn.querySelector(".jd-dots");
  const arrow = btn.querySelector(".jd-arrow");
  const bs = [...btn.querySelectorAll(".jd-dots b")];
  const is = [...btn.querySelectorAll(".jd-dots i")];
  const fv = (() => {
    try {
      return btn.matches(":focus-visible");
    } catch {
      return "n/a";
    }
  })();
  return [
    `button: shown=${btn.classList.contains("shown")} speaking=${btn.classList.contains("speaking")} focus-visible=${fv} opacity=${getComputedStyle(btn).opacity}`,
    `aria-label: ${btn.getAttribute("aria-label")}`,
    `dots: opacity=${dots ? r2(Number(getComputedStyle(dots).opacity)) : "-"} colour=${dots ? getComputedStyle(dots).color : "-"}`,
    `dot scales (b): ${bs.map((b) => r2(scaleOf(b))).join(" / ")}   slots (i): ${is.map((i) => getComputedStyle(i).transform).join(" | ")}`,
    `arrow: opacity=${arrow ? r2(Number(getComputedStyle(arrow).opacity)) : "-"} transform=${arrow ? getComputedStyle(arrow).transform : "-"}`,
    `throb animations on the dots: ${document.getAnimations().filter((a) => ((a as CSSAnimation).animationName ?? "").endsWith("jd-throb")).length}`,
  ].join("\n");
}

async function run() {
  await wait(400);
  app.project = project as unknown as typeof app.project;
  app.sessions = sessions as unknown as typeof app.sessions;
  const at = ago(10);
  const turn = (i: number) => [
    { event: "user_message", text: `Question ${i + 1}: walk me through hazard ${i + 1} in the five-stage pipeline.`, at },
    {
      event: "assistant_message",
      model: "claude-opus-5-5",
      blocks: [{ type: "text", text: "A load-use hazard happens when an instruction needs a register that the load just before it has not yet written. ".repeat(6) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1200, output_tokens: 300 },
    },
  ];
  app.events = Array.from({ length: 12 }, (_, i) => turn(i)).flat() as unknown as typeof app.events;
  app.events.push({ event: "user_message", text: "And the branch hazard?", at } as unknown as (typeof app.events)[number]);
  app.live = { segments: [{ kind: "text", text: "A branch hazard comes from not knowing, until the branch resolves, which instruction" }] };
  app.busy = true;
  await tick();
  await wait(300);
  const vp = document.querySelector<HTMLElement>(".transcript");
  if (vp) {
    // His wheel up, which unpins the view from the foot, then the scroll.
    vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    vp.scrollTop = 0;
    vp.dispatchEvent(new Event("scroll"));
  }
  // A delta streams in after the scroll (as in the app), which re-measures
  // the view: the offscreen snap window runs no animation frames, so the
  // scroll's own frame-timed measure never comes.
  await wait(100);
  app.live = { segments: [{ kind: "text", text: "A branch hazard comes from not knowing, until the branch resolves, which instruction comes next." }] };
  app.liveVersion++;
  await wait(300);
  await tick();
  if (q.get("reduced") === "1") cap.textContent += `reduced-motion rules copied: ${(window as unknown as { __reduce: () => number }).__reduce()}\n`;
  await wait(100);
  const btn = document.querySelector<HTMLButtonElement>(".jump-down");
  const log: string[] = [`step=${step} t=${t} m=${m} p=${document.documentElement.dataset.palette}`];
  if (vp) log.push(`view: scrollTop=${Math.round(vp.scrollTop)} of ${Math.round(vp.scrollHeight - vp.clientHeight)}`);
  if (step === "focus") {
    // A script can set neither :hover nor (in this WebKit) :focus-visible, so
    // the page's own `.jump-down.speaking:hover …` rules are copied with
    // `:hover` read as a harness class, and the class set on the button.
    const hover: string[] = [];
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const r of rules)
        if (r instanceof CSSStyleRule && /jump-down[^,{]*\.speaking[^,{]*:hover/.test(r.selectorText))
          hover.push(r.cssText.replace(/:hover/g, ".h304"));
    }
    const st = document.createElement("style");
    st.textContent = hover.join("\n");
    document.head.appendChild(st);
    log.push(`hover rules copied: ${hover.length}`);
    btn?.focus();
    btn?.classList.add("h304");
    await tick();
    // A style read, so the transitions exist before they are frozen.
    if (btn) for (const el of btn.querySelectorAll("*")) void getComputedStyle(el).transform;
  }
  if (step === "done") {
    app.live = null;
    app.busy = false;
    await tick();
    await wait(400);
  }
  if (step === "click") {
    btn?.click();
    await wait(1700);
    await tick();
    if (vp) log.push(`after the click: ${Math.round(vp.scrollHeight - vp.clientHeight - vp.scrollTop)} px from the foot`);
  }
  await wait(50);
  // The offscreen snap window advances no animation clock, so every frame is
  // set by hand: the throb (Svelte prefixes its name) at `t`; the dots' and
  // the ⌄'s transitions at `m` on the focus step; every other transition
  // (the button's fade-in, the settle after `done`) at its end.
  for (const a of document.getAnimations()) {
    const name = (a as CSSAnimation).animationName ?? "";
    const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
    a.pause();
    if (name.endsWith("jd-throb")) a.currentTime = t;
    else if (step === "focus" && target && target !== btn && btn?.contains(target)) a.currentTime = m;
    else a.currentTime = 10_000;
  }
  await wait(50);
  log.push(read(btn));
  log.push(`stub unknown: ${[...unknown].slice(0, 8).join(", ")}`);
  cap.textContent += log.join("\n");
  // Zoomed copy of the button for the frame strip.
  if (btn && q.get("zoom") !== "0") {
    const r = btn.getBoundingClientRect();
    cap.textContent += `\nbutton rect: ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;
  }
}
void run();
