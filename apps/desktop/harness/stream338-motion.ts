// Item 338 harness — the motion layer (see stream338.html). It watches a mounted
// AssistantMessage (the real one, unchanged) and adds the treatments from
// outside: a MutationObserver sees each delta land, before the frame paints,
// and decorates what is new. Harness only — the pick ships later inside the
// component itself; this layer is how the options can be compared without
// touching the real Transcript.
//
// The text treatments share one idea. The reply's markdown is re-rendered
// whole on every delta ({@html}), so the DOM of a word that arrived 200 ms ago
// is brand new on each delta. The layer therefore records *when* each stretch
// of characters arrived, and after each re-render wraps only the stretches
// still animating, giving each a negative `animation-delay` equal to its age —
// the animation picks up exactly where the replaced node left off. Once every
// stretch is done, nothing is wrapped and the DOM is the component's own.

export const TEXT = ["now", "fade", "shuttle", "paced", "cool", "shuttlefade"] as const;
export const THINK = ["now", "unfurl", "shimmer", "fold", "needle"] as const;
export const TOOL = ["now", "slide", "weft", "spring", "type"] as const;
export type TextT = (typeof TEXT)[number];
export type ThinkT = (typeof THINK)[number];
export type ToolT = (typeof TOOL)[number];

export const NAMES: Record<string, { title: string; what: string }> = {
  "text:now": { title: "As now", what: "Each delta appears the moment it lands, in its burst — today's behaviour, for comparison." },
  "text:fade": {
    title: "Ink rise",
    what: "Each new word fades up from a soft blur, rising a quarter-line, words in a chunk staggered 22 ms. The family of what Claude's own app does.",
  },
  "text:shuttle": {
    title: "Shuttle",
    what: "A small accent shuttle rides the writing point and glides to each new line — the send motion's shuttle, carried into the reply. New words carry a thin accent weft under them that fades.",
  },
  "text:shuttlefade": {
    title: "Shuttle + ink rise",
    what: "The shuttle and its fading weft, and each new word also fades up from a soft blur (his ask, 2026-10-11).",
  },
  "text:paced": {
    title: "Even pace",
    what: "Bursts are smoothed: words are released one at a time at an even cadence (the backlog always drains within ~350 ms), each with a short fade. Fixes the jerky stall-then-burst.",
  },
  "text:cool": {
    title: "Cooling thread",
    what: "New words arrive in the accent colour with a faint glow and cool to ink over a second, so the newest line reads as a warm tail behind the writing point.",
  },
  "think:now": { title: "As now", what: "The thinking text appears, grows line by line, and vanishes when the block is done." },
  "think:unfurl": {
    title: "Unfurl",
    what: "Opens by growing from zero height; each new line glides the block taller instead of jumping; on done it folds shut smoothly and the label cross-fades to “thought for N s”.",
  },
  "think:shimmer": {
    title: "Ticker",
    what: "While thinking, the label shimmers and the text is a five-line window that scrolls under a top fade — the block never pushes the reply down more than five lines. On done the window closes.",
  },
  "think:fold": {
    title: "Fold into the row",
    what: "The text drops out of its row on open; on done it fades and shrinks up and left into the row like a window minimising, and the row settles with the send motion's accent ring.",
  },
  "think:needle": {
    title: "Needle",
    what: "An accent thread draws itself down the left margin as the block opens, with a glowing needle at the newest line; on done the thread retracts up into the think icon, which turns once.",
  },
  "tool:now": { title: "As now", what: "Rows appear at once; “running” changes to the size at once." },
  "tool:slide": {
    title: "Slide",
    what: "A new row slides in from the left and fades up; when it finishes, the size cross-fades in and the icon flashes accent (red on an error).",
  },
  "tool:weft": {
    title: "Weft",
    what: "A thin accent thread draws across the row as it appears, and a bright shuttle runs back and forth along it while the call runs; on finish the thread fills and fades.",
  },
  "tool:spring": {
    title: "Spring",
    what: "The row opens its space with a slight overshoot and the icon pops in; on finish a ring settles out from the icon, like the send motion's landing.",
  },
  "tool:type": {
    title: "Type-on",
    what: "The command types itself out left to right; a block cursor blinks after “running”; on finish the size types on.",
  },
};

export interface Config {
  text: TextT;
  think: ThinkT;
  tool: ToolT;
}

export interface LayerStats {
  /** Time spent inside the layer's own callbacks, ms. */
  ms: number;
  calls: number;
}

const DUR: Record<TextT, number> = { now: 0, fade: 520, shuttle: 900, paced: 240, cool: 1100, shuttlefade: 900 };
const PACE_WINDOW = 350;

interface Range {
  from: number;
  to: number;
  start: number;
}
interface MdState {
  len: number;
  ranges: Range[];
  paceCursor: number;
}

const now = () => performance.now();

function rowOf(n: Node | null): HTMLElement | null {
  const el = n instanceof HTMLElement ? n : (n?.parentElement ?? null);
  return el?.closest<HTMLElement>(".row-wrap") ?? null;
}

export function attach(root: HTMLElement, cfg: Config, reduced: () => boolean) {
  const stats: LayerStats = { ms: 0, calls: 0 };
  const md = new WeakMap<HTMLElement, MdState>();
  const sizeText = new WeakMap<HTMLElement, string>();
  const thinkH = new WeakMap<HTMLElement, number>();
  let lastMd: HTMLElement | null = null;
  let lastArrival = -1e9;

  root.classList.add("m-root", `m-text-${cfg.text}`, `m-think-${cfg.think}`, `m-tool-${cfg.tool}`);

  // ---- text ------------------------------------------------------------------

  function record(el: HTMLElement) {
    const full = el.textContent ?? "";
    // Measured without the trailing newlines the rendered blocks end in ("</li>\n</ol>\n"):
    // counted, they shift every later arrival a character or two into the word before.
    const L = full.trimEnd().length;
    let s = md.get(el);
    if (!s) {
      s = { len: 0, ranges: [], paceCursor: 0 };
      md.set(el, s);
    }
    const t = now();
    if (L < s.len) {
      s.len = L;
      s.ranges = s.ranges.filter((r) => r.from < L);
    }
    if (L > s.len) {
      lastMd = el;
      lastArrival = t;
      const from = s.len;
      if (cfg.text === "shuttle") s.ranges.push({ from, to: L, start: t });
      else if (cfg.text !== "now") {
        const re = /\S+/g;
        const slice = full.slice(from);
        const words: [number, number][] = [];
        for (let m = re.exec(slice); m; m = re.exec(slice)) words.push([from + m.index, from + m.index + m[0].length]);
        // A delta that ends mid-word (the engine's tokens are sub-word): the rest of
        // the word keeps its first piece's timing, or simply shows if that piece is done.
        let carry: number | null = null;
        if (words.length && words[0][0] === from && from > 0 && /\S/.test(full[from - 1])) {
          const prev = s.ranges.find((r) => r.to === from);
          carry = prev ? prev.start : t - DUR[cfg.text];
        }
        if (cfg.text === "paced") {
          const pending = s.ranges.filter((r) => r.start > t).length + words.length;
          const gap = Math.min(45, Math.max(6, PACE_WINDOW / Math.max(1, pending)));
          words.forEach(([a, b], k) => {
            if (k === 0 && carry !== null) return void s!.ranges.push({ from: a, to: b, start: carry });
            s!.paceCursor = Math.max(t, s!.paceCursor + gap);
            s!.ranges.push({ from: a, to: b, start: s!.paceCursor });
          });
        } else {
          const stagger = cfg.text === "fade" || cfg.text === "shuttlefade" ? 22 : 16;
          words.forEach(([a, b], k) =>
            s!.ranges.push({ from: a, to: b, start: k === 0 && carry !== null ? carry : t + Math.min(k * stagger, 160) }),
          );
        }
      }
      s.len = L;
    }
    const dur = DUR[cfg.text];
    s.ranges = s.ranges.filter((r) => r.start + dur > t);
    if (s.ranges.length) decorate(el, s, full.length, t);
  }

  /** Wrap the still-animating stretches, walking text nodes back from the end. */
  function decorate(el: HTMLElement, s: MdState, L: number, t: number) {
    const minFrom = s.ranges[0].from;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.lastChild() as Text | null;
    let end = L;
    const todo: [Text, number][] = [];
    while (node && end > minFrom) {
      const a = end - node.data.length;
      todo.push([node, a]);
      end = a;
      node = walker.previousNode() as Text | null;
    }
    for (const [n, a] of todo) {
      const p = n.parentElement;
      // Top-level nodes are the {@html} block's own bookends; KaTeX is left whole;
      // a node already wrapped is already animating.
      if (!p || p === el || p.classList.contains("m-w") || p.closest(".katex")) continue;
      const b = a + n.data.length;
      const hits = s.ranges.filter((r) => r.to > a && r.from < b);
      if (!hits.length) continue;
      const frag = document.createDocumentFragment();
      let cur = a;
      for (const r of hits) {
        const x = Math.max(r.from, a);
        const y = Math.min(r.to, b);
        if (x > cur) frag.append(n.data.slice(cur - a, x - a));
        const span = document.createElement("span");
        span.className = "m-w";
        span.style.animationDelay = `${Math.round(r.start - t)}ms`;
        span.textContent = n.data.slice(x - a, y - a);
        frag.append(span);
        cur = y;
      }
      if (cur < b) frag.append(n.data.slice(cur - a));
      n.replaceWith(frag);
    }
  }

  // The shuttle: one element per layer, eased toward the writing point every frame.
  let shuttle: HTMLElement | null = null;
  let sx = 0;
  let sy = 0;
  let raf = 0;
  if (cfg.text === "shuttle" || cfg.text === "shuttlefade") {
    shuttle = document.createElement("div");
    shuttle.className = "m-shuttle";
    shuttle.setAttribute("aria-hidden", "true");
    root.appendChild(shuttle);
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (reduced() || !shuttle) return;
      const age = now() - lastArrival;
      const target = lastMd && age < 900 ? headOf(lastMd) : null;
      if (!target) {
        shuttle.style.opacity = "0";
        return;
      }
      const base = root.getBoundingClientRect();
      const tx = target.x - base.left;
      const ty = target.y - base.top;
      if (shuttle.style.opacity !== "1" || Math.abs(ty - sy) > 400) {
        sx = tx;
        sy = ty;
      }
      // y settles fast, x glides: a new line reads as the shuttle's return across.
      sx += (tx - sx) * 0.22;
      sy += (ty - sy) * 0.45;
      shuttle.style.opacity = "1";
      shuttle.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
    };
    raf = requestAnimationFrame(frame);
  }

  function headOf(el: HTMLElement): { x: number; y: number } | null {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n = walker.lastChild() as Text | null;
    while (n && !/\S/.test(n.data)) n = walker.previousNode() as Text | null;
    if (!n) return null;
    let i = n.data.length;
    while (i > 0 && /\s/.test(n.data[i - 1])) i--;
    const r = document.createRange();
    r.setStart(n, Math.max(0, i - 1));
    r.setEnd(n, i);
    const rects = r.getClientRects();
    const rect = rects[rects.length - 1];
    if (!rect) return null;
    return { x: rect.right + 3, y: rect.top + rect.height / 2 };
  }

  // ---- thinking --------------------------------------------------------------

  const EASE = "cubic-bezier(.2,.7,.2,1)";

  function thinkOpen(el: HTMLElement) {
    const row = rowOf(el);
    row?.classList.add("m-live");
    const h = el.offsetHeight;
    thinkH.set(el, h);
    if (cfg.think === "unfurl") {
      el.animate([{ height: "0px", opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: 260, easing: EASE });
    } else if (cfg.think === "shimmer") {
      el.animate([{ maxHeight: "0px", opacity: 0 }, { maxHeight: "6.4em", opacity: 1 }], { duration: 240, easing: EASE });
    } else if (cfg.think === "fold") {
      el.animate(
        [
          { opacity: 0, transform: "translateY(-10px) scaleY(.9)", transformOrigin: "top left" },
          { opacity: 1, transform: "none", transformOrigin: "top left" },
        ],
        { duration: 300, easing: EASE },
      );
    } else if (cfg.think === "needle") {
      const ink = getComputedStyle(el).color;
      el.animate(
        [
          { backgroundSize: "2px 0%", color: "transparent" },
          { backgroundSize: "2px 100%", color: "transparent", offset: 0.5 },
          { backgroundSize: "2px 100%", color: ink },
        ],
        { duration: 420, easing: "ease-out" },
      );
    }
  }

  function thinkGrow(el: HTMLElement) {
    if (cfg.think !== "unfurl") return;
    // Measured mid-animation, offsetHeight is the animated height, not the
    // text's: each grow then ended short and a line stayed cut in half (his
    // report, 2026-10-11). Stop the running grow, measure the real height,
    // glide from where the box is now.
    const running = el.getAnimations();
    const from = running.length ? el.getBoundingClientRect().height : (thinkH.get(el) ?? 0);
    running.forEach((a) => a.cancel());
    const h = el.offsetHeight;
    thinkH.set(el, h);
    if (h > from && from > 0) el.animate([{ height: `${from}px` }, { height: `${h}px` }], { duration: 170, easing: "ease-out" });
  }

  function thinkClose(removed: HTMLElement, parent: Node, next: Node | null) {
    const row = parent instanceof HTMLElement ? parent : null;
    row?.classList.remove("m-live");
    if (!row || !row.isConnected || cfg.think === "now") return;
    const ghost = removed.cloneNode(true) as HTMLElement;
    ghost.classList.add("m-ghost");
    ghost.setAttribute("aria-hidden", "true");
    row.insertBefore(ghost, next && next.parentNode === row ? next : null);
    const h = ghost.offsetHeight;
    let a: Animation;
    if (cfg.think === "unfurl" || cfg.think === "shimmer") {
      a = ghost.animate([{ height: `${h}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 360, easing: "cubic-bezier(.4,0,.2,1)" });
    } else if (cfg.think === "fold") {
      ghost.animate([{ color: getComputedStyle(ghost).color }, { color: "transparent", offset: 0.3 }, { color: "transparent" }], { duration: 380 });
      a = ghost.animate(
        [
          { height: `${h}px`, transform: "none", opacity: 1 },
          { height: "0px", transform: "translate(-24px,-14px) scale(.4)", opacity: 0 },
        ],
        { duration: 380, easing: "cubic-bezier(.5,0,.2,1)" },
      );
      const btn = row.querySelector<HTMLElement>(".arow");
      btn?.animate(
        [
          { boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent)" },
          { boxShadow: "inset 0 0 0 1px transparent" },
        ],
        { duration: 700, delay: 280, easing: "ease-out" },
      );
    } else {
      ghost.animate([{ color: getComputedStyle(ghost).color }, { color: "transparent", offset: 0.35 }, { color: "transparent" }], { duration: 420 });
      a = ghost.animate(
        [
          { height: `${h}px`, backgroundSize: "2px 100%" },
          { height: `${h}px`, backgroundSize: "2px 100%", offset: 0.35 },
          { height: "0px", backgroundSize: "2px 0%" },
        ],
        { duration: 420, easing: "ease-in-out" },
      );
      row.querySelector<HTMLElement>(".ico")?.animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], {
        duration: 520,
        delay: 200,
        easing: EASE,
      });
    }
    a.onfinish = () => ghost.remove();
  }

  function labelChanged(name: HTMLElement) {
    const row = rowOf(name);
    const live = name.textContent?.trim() === "thinking";
    row?.classList.toggle("m-live", live);
    if (!live && cfg.think !== "now") {
      name.animate(
        [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 280, easing: EASE },
      );
      if (cfg.think === "fold") name.animate([{ color: "var(--accent)" }, { color: "var(--accent)", offset: 0.3 }, { color: getComputedStyle(name).color }], { duration: 900 });
    }
  }

  // ---- tools -----------------------------------------------------------------

  function toolAppear(row: HTMLElement) {
    const size = row.querySelector<HTMLElement>(":scope > .arow .size");
    const txt = size?.textContent?.trim() ?? "";
    if (size) sizeText.set(size, txt);
    row.classList.toggle("m-running", txt === "running");
    if (cfg.tool === "slide") {
      row.animate(
        [
          { opacity: 0, transform: "translateX(-12px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 300, easing: EASE },
      );
    } else if (cfg.tool === "weft") {
      const w = document.createElement("span");
      w.className = "m-weft";
      w.setAttribute("aria-hidden", "true");
      row.appendChild(w);
      w.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 320, easing: EASE });
      row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    } else if (cfg.tool === "spring") {
      const h = row.offsetHeight;
      row.animate(
        [
          { height: "0px", opacity: 0, overflow: "hidden" },
          { height: `${h}px`, opacity: 1, overflow: "hidden" },
        ],
        { duration: 420, easing: "cubic-bezier(.34,1.56,.64,1)" },
      );
      row.querySelector<HTMLElement>(".ico")?.animate([{ transform: "scale(.3)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], {
        duration: 380,
        delay: 80,
        easing: "cubic-bezier(.34,1.8,.64,1)",
        fill: "backwards",
      });
    } else if (cfg.tool === "type") {
      const arg = row.querySelector<HTMLElement>(":scope > .arow .arg");
      const n = Math.max(1, Math.min(60, arg?.textContent?.length ?? 1));
      arg?.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: Math.min(700, n * 14), easing: `steps(${n})` });
    }
  }

  function toolChanged(size: HTMLElement) {
    const row = rowOf(size);
    if (!row || !row.classList.contains("tool")) return;
    const was = sizeText.get(size);
    const txt = size.textContent?.trim() ?? "";
    sizeText.set(size, txt);
    row.classList.toggle("m-running", txt === "running");
    if (was !== "running" || txt === "running") return;
    const bad = row.querySelector(":scope > .arow.error") !== null;
    const hue = bad ? "var(--error, #e06c6c)" : "var(--accent)";
    if (cfg.tool === "slide") {
      size.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
      row.querySelector<HTMLElement>(".ico")?.animate([{ color: hue }, { color: hue, offset: 0.4 }, { color: "inherit" }], { duration: 700 });
    } else if (cfg.tool === "weft") {
      const w = row.querySelector<HTMLElement>(".m-weft");
      if (w) {
        w.classList.add("m-done");
        w.animate([{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }], { duration: 650, easing: "ease-out" }).onfinish = () => w.remove();
      }
      size.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
    } else if (cfg.tool === "spring") {
      const ico = row.querySelector<HTMLElement>(".ico");
      ico?.animate(
        [
          { boxShadow: `0 0 0 0 color-mix(in srgb, ${hue} 55%, transparent)`, borderRadius: "50%" },
          { boxShadow: "0 0 0 9px transparent", borderRadius: "50%" },
        ],
        { duration: 480, easing: "ease-out" },
      );
      size.animate([{ transform: "scale(.7)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 300, easing: "cubic-bezier(.34,1.56,.64,1)" });
    } else if (cfg.tool === "type") {
      const n = Math.max(1, txt.length);
      size.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: Math.min(400, n * 30), easing: `steps(${n})` });
    }
  }

  function subAppear(el: HTMLElement) {
    if (cfg.tool === "now") return;
    if (cfg.tool === "spring") {
      const h = el.offsetHeight;
      el.animate([{ height: "0px", opacity: 0, overflow: "hidden" }, { height: `${h}px`, opacity: 1, overflow: "hidden" }], {
        duration: 420,
        easing: "cubic-bezier(.34,1.56,.64,1)",
      });
    } else if (cfg.tool === "slide") {
      el.animate([{ opacity: 0, transform: "translateX(-12px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE });
    } else el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
  }

  function subChanged(el: HTMLElement) {
    if (cfg.tool === "now") return;
    el.animate([{ color: "var(--accent)" }, { color: getComputedStyle(el).color }], { duration: 600, easing: "ease-out" });
  }

  // ---- the observer ------------------------------------------------------------

  const each = (n: Node, sel: string, f: (e: HTMLElement) => void) => {
    if (!(n instanceof HTMLElement)) return;
    if (n.matches(sel)) f(n);
    n.querySelectorAll<HTMLElement>(sel).forEach(f);
  };

  const obs = new MutationObserver((recs) => {
    if (reduced()) return;
    const t0 = now();
    const mds = new Set<HTMLElement>();
    const grown = new Set<HTMLElement>();
    for (const r of recs) {
      const tgt = r.target instanceof HTMLElement ? r.target : r.target.parentElement;
      if (!tgt) continue;
      const m = tgt.closest<HTMLElement>(".markdown");
      if (m && root.contains(m)) mds.add(m);
      const tt = tgt.closest<HTMLElement>(".thinking-text");
      if (tt && !tt.classList.contains("m-ghost")) grown.add(tt);
      const size = tgt.closest<HTMLElement>(".size");
      if (size) toolChanged(size);
      const name = tgt.closest<HTMLElement>(".arow.thinking .name");
      if (name && r.type !== "attributes") labelChanged(name);
      const subArg = tgt.closest<HTMLElement>(".sub-line .arg");
      if (subArg) subChanged(subArg);
      r.addedNodes.forEach((n) => {
        each(n, ".markdown", (e) => mds.add(e));
        each(n, ".thinking-text", (e) => {
          if (!e.classList.contains("m-ghost")) thinkOpen(e);
        });
        each(n, ".row-wrap.tool", toolAppear);
        each(n, "details.sub", subAppear);
      });
      r.removedNodes.forEach((n) => {
        if (n instanceof HTMLElement && n.classList.contains("thinking-text") && !n.classList.contains("m-ghost")) thinkClose(n, r.target, r.nextSibling);
      });
    }
    grown.forEach(thinkGrow);
    mds.forEach(record);
    obs.takeRecords(); // our own wrapping is not a delta
    stats.ms += now() - t0;
    stats.calls++;
  });
  obs.observe(root, { childList: true, subtree: true, characterData: true });

  return {
    stats,
    detach() {
      obs.disconnect();
      cancelAnimationFrame(raf);
      shuttle?.remove();
    },
  };
}
