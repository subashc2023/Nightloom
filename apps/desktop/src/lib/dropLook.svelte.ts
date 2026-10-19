/*
 * Item 362 — the window side of the drop look (`dropLook.ts` holds the
 * look and why). One watcher on the window follows a file drag: which box
 * it is over (`drop.kind`), a `drop-over` class on that box, and — when it
 * is over the chat outside any box — takes the drop itself for the chat's
 * composer (`registerChatDrop`). At the drop it marks the files' names so
 * their chips arrive with the drop's motion, and adds a landing (the
 * dragged files shrinking into the box, the ripple) for `DropOverlay`.
 *
 * The boxes keep their own `dragover`/`drop` handlers (Composer, the edit
 * box): the watcher listens in the capture phase and accepts nothing that
 * lands in a box.
 */
import { DropMarks, carriesFiles, dropKind, landTiles, type DropKind, type LandTile } from "./dropLook";
import { prefersReducedMotion } from "./chipFade";

export type Landing = {
  id: number;
  x: number;
  y: number;
  /** Where the files go: the box's chip row, in window coordinates. */
  toX: number;
  toY: number;
  tiles: LandTile[];
  more: number;
};

export const drop = $state<{ kind: DropKind | "idle"; landings: Landing[] }>({ kind: "idle", landings: [] });

export const dropMarks = new DropMarks();

type Sink = { accept: (files: File[]) => void; card: () => Element | null };
const sinks: Sink[] = [];

/** The chat's composer offers itself as the taker of drops on the chat
 *  (the last mounted wins); returns the unregister. */
export function registerChatDrop(sink: Sink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}
const sink = (): Sink | null => sinks[sinks.length - 1] ?? null;

let depth = 0;
let over: Element | null = null;
let lastOver = 0;
let stale: ReturnType<typeof setInterval> | null = null;
let landingId = 0;

function setOver(el: Element | null): void {
  if (over === el) return;
  over?.classList.remove("drop-over");
  over = el;
  over?.classList.add("drop-over");
}

function reset(): void {
  depth = 0;
  setOver(null);
  if (drop.kind !== "idle") drop.kind = "idle";
  if (stale) {
    clearInterval(stale);
    stale = null;
  }
}

function track(e: DragEvent): DropKind {
  const { kind, box } = dropKind(e.target);
  setOver((box as Element | null) ?? null);
  if (drop.kind !== kind) drop.kind = kind;
  lastOver = performance.now();
  // A drag that leaves the window may not say so; one that stops sending
  // `dragover` (AppKit sends it periodically even when the pointer rests)
  // is gone. Armed on every tracked event, not only `dragenter`: a reset
  // by this timer clears it, and a drag that goes on after one must be
  // watched again (review of 362, 2026-10-15).
  stale ??= setInterval(() => {
    if (performance.now() - lastOver > 1500) reset();
  }, 500);
  return kind;
}

function onEnter(e: DragEvent): void {
  if (!carriesFiles(e.dataTransfer)) return;
  depth++;
  track(e);
}

function onOver(e: DragEvent): void {
  if (!carriesFiles(e.dataTransfer)) return;
  if (track(e) === "chat" && sink()) {
    // The chat takes the drop for its box (B): without this the drop
    // would not happen here.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }
}

function onLeave(e: DragEvent): void {
  if (!carriesFiles(e.dataTransfer)) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) reset();
}

function onDrop(e: DragEvent): void {
  const files = Array.from(e.dataTransfer?.files ?? []);
  const { kind, box } = dropKind(e.target);
  reset();
  if (files.length === 0 || kind === "none") return;
  const s = sink();
  if (kind === "chat" && !s) return;
  const now = performance.now();
  dropMarks.mark(
    files.map((f) => f.name),
    now,
  );
  const target = kind === "box" ? (box as Element) : (s?.card() ?? null);
  if (!prefersReducedMotion() && target) {
    const r = target.getBoundingClientRect();
    const { tiles, more } = landTiles(files);
    const id = ++landingId;
    drop.landings.push({
      id,
      x: e.clientX,
      y: e.clientY,
      // Into the box where it was dropped; from the chat, to the box's
      // chip row (its top-left, where the first chip lands).
      toX: kind === "chat" ? r.left + 40 : e.clientX,
      toY: kind === "chat" ? r.top - 30 : e.clientY,
      tiles,
      more,
    });
  }
  if (kind === "chat" && s) {
    e.preventDefault();
    s.accept(files);
  }
}

export function endLanding(id: number): void {
  const i = drop.landings.findIndex((l) => l.id === id);
  if (i >= 0) drop.landings.splice(i, 1);
}

let installs = 0;
/** Installs the window watcher (counted; the last uninstall removes it). */
export function watchDrops(): () => void {
  if (installs++ === 0) {
    window.addEventListener("dragenter", onEnter, true);
    window.addEventListener("dragover", onOver, true);
    window.addEventListener("dragleave", onLeave, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("dragend", reset, true);
  }
  return () => {
    if (--installs > 0) return;
    window.removeEventListener("dragenter", onEnter, true);
    window.removeEventListener("dragover", onOver, true);
    window.removeEventListener("dragleave", onLeave, true);
    window.removeEventListener("drop", onDrop, true);
    window.removeEventListener("dragend", reset, true);
    reset();
  };
}

/** Item 388: a paste's image chips land as dropped ones do (the drop's
 *  ending: the row opens, the chip rises and scales in, the accent ring
 *  fades off it) — marked by the names their chips will have, in order. */
export function markPasted(names: readonly string[]): void {
  if (names.length > 0) dropMarks.mark(names, performance.now());
}

/** For a box's chip: its place in the drop that made it, or null. */
export function takeDropped(name: string): number | null {
  return dropMarks.take(name, performance.now());
}
export function dropPending(): boolean {
  return dropMarks.recent(performance.now());
}
