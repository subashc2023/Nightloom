/**
 * The "Claude asks you" card's motion (items 713 + 753, wave K; his pick, blocker 2031: "I like lock-on, but
 * I like the answer animation (in the left screens) from the option B"). One module for both hosts — the
 * mid-turn question card (ApprovalPrompt) and the turn-end card (TurnAsk) — and the Needs-you view.
 *
 * Arrival (Lock-on, CSS in app.css §"ask lock-on", drawn by `AskLock.svelte`): four amber corner brackets fly
 * in to the card's corners, a scanline sweeps the card top to bottom while a veil in the card's own colour
 * lifts behind it, and the header decodes (`decodeAt`). The brackets then breathe while the card waits.
 *
 * Answer (Thread, `flyAnswer`): the card is copied into a fixed overlay at its exact place (the real card is
 * gone the moment the answer is sent — nothing waits on the motion), a thread draws from the picked answer
 * down the card's left side into the message box with a bright bead riding it, the box flashes, and the copy
 * folds to a one-line ANSWERED receipt, turns green, holds and fades.
 *
 *   0–520 ms     the thread draws; the bead rides it (0–460)
 *   300–900      the message box's edge flashes amber
 *   380–740      the copy folds to the receipt; its edge turns green
 *   740–1400     the receipt holds
 *   1400–1660    it fades; the overlay goes
 *
 * Jarvis only. Classic gets a calm version (the copy fades in place over 200 ms, no thread, no brackets);
 * `prefers-reduced-motion: reduce` gets nothing at all. Every moving part is a Web Animation (CSS or
 * `Element.animate`), so a harness can hold any instant through `document.getAnimations()`.
 */

export const ARRIVE = { brackets: 450, scanFrom: 180, scanTo: 900, decodeFrom: 120, decodeTo: 720 } as const;
export const CARRY_MS = 520;
export const BEAD_MS = 460;
export const FLASH = { from: 300, to: 900 } as const;
export const FOLD = { from: 380, to: 740 } as const;
export const FADE = { from: 1400, to: 1660 } as const;
export const CALM_MS = 200;
export const RECEIPT_H = 38;

export type Look = "jarvis" | "classic" | "none";

function reduced(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Which motion this window draws: Jarvis's, Classic's calm one, or none (reduce motion). */
export function look(root: Element | null = typeof document !== "undefined" ? document.documentElement : null): Look {
  if (reduced()) return "none";
  return root?.getAttribute("data-layout") === "classic" ? "classic" : "jarvis";
}

const GLYPHS = "#%&*+/<=>?01ABDX";

/** The header mid-decode at `ms`: settled characters from the left, scrambled ones after (spaces kept).
 *  `seed` makes a frame repeatable for tests and held harness frames. */
export function decodeAt(text: string, ms: number, seed = 7): string {
  const span = ARRIVE.decodeTo - ARRIVE.decodeFrom;
  const p = Math.max(0, Math.min(1, (ms - ARRIVE.decodeFrom) / span));
  if (p >= 1) return text;
  const n = Math.floor(p * text.length);
  let s = seed + Math.floor(ms / 50);
  let out = text.slice(0, n);
  for (const ch of text.slice(n)) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out += /\s|·/.test(ch) ? ch : GLYPHS[(s >> 16) % GLYPHS.length];
  }
  return out;
}

/** The answer motion's state at `ms` (0..1 each) — the timeline the animations below are built from. */
export function flightAt(ms: number): { trail: number; bead: number; flash: number; fold: number; fade: number } {
  const seg = (a: number, b: number) => Math.max(0, Math.min(1, (ms - a) / (b - a)));
  return {
    trail: seg(0, CARRY_MS),
    bead: seg(0, BEAD_MS),
    flash: ms < FLASH.from || ms > FLASH.to ? 0 : 1 - Math.abs((ms - FLASH.from) / (FLASH.to - FLASH.from) - 0.25) / 0.75,
    fold: seg(FOLD.from, FOLD.to),
    fade: seg(FADE.from, FADE.to),
  };
}

/** The message box the answer goes into: the visible `.composer` under the card, else the first visible one. */
function composerFor(card: DOMRect): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(".composer")].filter((c) => c.getBoundingClientRect().height > 0);
  const below = all.find((c) => {
    const r = c.getBoundingClientRect();
    return r.top >= card.top && r.left < card.right && r.right > card.left;
  });
  return below ?? all[0] ?? null;
}

/** A copy of the card, fixed over the page at its place — form values carried, ids dropped. */
function ghostOf(card: HTMLElement, r: DOMRect): HTMLElement {
  const g = card.cloneNode(true) as HTMLElement;
  const src = card.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input");
  g.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input").forEach((el, k) => {
    const from = src[k];
    if (from) {
      if (el instanceof HTMLInputElement) el.checked = (from as HTMLInputElement).checked;
      el.value = from.value;
    }
  });
  g.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  g.querySelectorAll("[data-decode]").forEach((el) => el.removeAttribute("data-decode"));
  g.removeAttribute("id");
  g.setAttribute("aria-hidden", "true");
  g.classList.add("ask-ghost");
  const cs = getComputedStyle(card);
  for (const v of ["--transcript-font", "--transcript-size", "--aq-bg"]) {
    const val = cs.getPropertyValue(v);
    if (val) g.style.setProperty(v, val);
  }
  Object.assign(g.style, {
    position: "fixed",
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    maxHeight: "none",
    margin: "0",
    zIndex: "9000",
    pointerEvents: "none",
    overflow: "hidden",
    boxSizing: "border-box",
  });
  return g;
}

let live: HTMLElement[] = [];

/** Clear any overlay still on screen (a second answer before the first one's motion ended). */
export function clearFlights(): void {
  for (const el of live) el.remove();
  live = [];
}

/**
 * The answer motion, started at the moment the answer is sent. `card` is the card's shell, `pick` the picked
 * answer's row (null: Other, or several questions — the thread leaves from the card's head), `receipt` the
 * receipt's words. Returns the overlay's nodes (for the harness), or [] when nothing is drawn.
 */
export function flyAnswer(card: HTMLElement | null, pick: HTMLElement | null, receipt: string): HTMLElement[] {
  if (!card || typeof document === "undefined") return [];
  const kind = look();
  if (kind === "none") return [];
  const r = card.getBoundingClientRect();
  if (r.height === 0 || r.bottom < 0 || r.top > innerHeight) return [];
  clearFlights();
  const ghost = ghostOf(card, r);
  document.body.appendChild(ghost);
  const sc = card.scrollTop;
  if (sc) ghost.scrollTop = sc;
  // A harness holding a frame (`window.__askMotionHold = true`) keeps the overlay after its timeline.
  const done = (els: HTMLElement[], at: number) =>
    setTimeout(() => {
      if (!(globalThis as { __askMotionHold?: boolean }).__askMotionHold) els.forEach((e) => e.remove());
    }, at + 40);

  if (kind === "classic") {
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CALM_MS, easing: "ease-out", fill: "forwards" });
    live = [ghost];
    done(live, CALM_MS);
    return live;
  }

  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue("--accent").trim() || "#ffb454";
  const accentInk = cs.getPropertyValue("--accent-ink").trim() || accent;
  const doneInk = cs.getPropertyValue("--done").trim() || "#7cd69a";
  const lit = (cs.getPropertyValue("--glow-accent").trim() || "none") !== "none";

  // The thread: from the picked answer, out to the card's left edge, down to the message box, into it.
  const box = composerFor(r);
  const nodes: HTMLElement[] = [ghost];
  if (box) {
    const b = box.getBoundingClientRect();
    const p = pick?.getBoundingClientRect() ?? null;
    const y0 = p ? p.top + p.height / 2 : r.top + 18;
    const x0 = p ? p.left + 14 : r.left + 20;
    const xs = Math.max(4, r.left - 12);
    const y1 = b.top + Math.min(b.height / 2, 24);
    const d = `M${x0},${y0} H${xs} V${y1} H${b.left + 22}`;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "ask-thread");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", String(innerWidth));
    svg.setAttribute("height", String(innerHeight));
    Object.assign((svg as unknown as HTMLElement).style, { position: "fixed", left: "0", top: "0", zIndex: "9001", pointerEvents: "none", overflow: "visible" });
    const trail = document.createElementNS(ns, "path");
    const bead = document.createElementNS(ns, "path");
    for (const [el, w, col] of [
      [trail, 1.2, accent],
      [bead, 3, accentInk],
    ] as const) {
      el.setAttribute("d", d);
      el.setAttribute("pathLength", "1");
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", col);
      el.setAttribute("stroke-width", String(w));
      el.setAttribute("stroke-linecap", "round");
      if (lit) (el as unknown as HTMLElement).style.filter = `drop-shadow(0 0 ${w > 2 ? 6 : 3}px ${accent})`;
      svg.appendChild(el);
    }
    trail.setAttribute("stroke-dasharray", "1 1");
    bead.setAttribute("stroke-dasharray", "0.14 1");
    document.body.appendChild(svg);
    nodes.push(svg as unknown as HTMLElement);
    trail.animate(
      [
        { strokeDashoffset: 1, opacity: 1, offset: 0 },
        { strokeDashoffset: 0, opacity: 1, offset: CARRY_MS / FOLD.to },
        { strokeDashoffset: 0, opacity: 0, offset: 1 },
      ],
      { duration: FOLD.to, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
    );
    bead.animate(
      [
        { strokeDashoffset: 0.14, opacity: 1, offset: 0 },
        { strokeDashoffset: -0.86, opacity: 1, offset: 0.85 },
        { strokeDashoffset: -1, opacity: 0, offset: 1 },
      ],
      { duration: BEAD_MS, easing: "cubic-bezier(.5,0,.3,1)", fill: "forwards" },
    );
    box.animate(
      [
        { boxShadow: `0 0 0 1px ${accent}, 0 0 18px color-mix(in srgb, ${accent} 40%, transparent)`, offset: 0.25 },
        { boxShadow: "0 0 0 0 transparent", offset: 1 },
      ],
      { duration: FLASH.to - FLASH.from, delay: FLASH.from, easing: "ease-out" },
    );
  }

  // The fold: the copy's contents fade, a receipt line fades in, the copy shrinks to the receipt and turns green.
  const rc = document.createElement("div");
  rc.className = "ask-receipt";
  rc.innerHTML = `<span class="ask-stamp">Answered</span><span class="ask-rt"></span>`;
  (rc.querySelector(".ask-rt") as HTMLElement).textContent = receipt;
  ghost.appendChild(rc);
  const fold = { duration: FOLD.to - FOLD.from, delay: FOLD.from, easing: "cubic-bezier(.4,0,.2,1)", fill: "both" as const };
  for (const kid of [...ghost.children] as HTMLElement[]) {
    if (kid === rc || kid.classList.contains("lk")) continue;
    kid.animate([{ opacity: 1 }, { opacity: 0 }], { ...fold, duration: (FOLD.to - FOLD.from) * 0.6 });
  }
  rc.animate([{ opacity: 0 }, { opacity: 1 }], { ...fold, delay: FOLD.from + 120, duration: 240 });
  ghost.animate([{ height: `${r.height}px` }, { height: `${RECEIPT_H}px` }], fold);
  ghost.animate([{ borderColor: getComputedStyle(card).borderTopColor }, { borderColor: doneInk }], fold);
  ghost.querySelectorAll<HTMLElement>(".lk-br").forEach((br) => br.animate([{ borderColor: accent }, { borderColor: doneInk }], fold));
  ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE.to - FADE.from, delay: FADE.from, easing: "ease-in", fill: "forwards" });
  live = nodes;
  done(nodes, FADE.to);
  return nodes;
}
