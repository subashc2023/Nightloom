// Item 874: a window that stops drawing is never silent again.
//   1. Every uncaught error — a thrown handler, a rejected promise, an effect Svelte gave up on — is appended to
//      `~/.nightloom/logs/frontend-errors.log` (`frontend_error_log`, Rust).
//   2. After each one, and every 5 s, a liveness probe: an effect in the App (`probeWatch`) is poked; if Svelte no longer runs it
//      within a second, the runtime has stopped flushing (874: an effect loop froze the whole window, every click dead) and a
//      plain-DOM bar — drawn without Svelte, which is the thing that died — offers "Reload view". Drafts live in the
//      window's storage and come back after the reload; a turn keeps running in the app.
import { invoke } from "@tauri-apps/api/core";
import { untrack } from "svelte";

const BAR_ID = "nl-dead-bar";
let probe = $state(0);
let seen = 0;
let installed = false;
let checking = false;

/** One error, as a line for the log: its message and the top of its stack. Pure. */
export function errorLine(kind: string, e: unknown): string {
  const err = e as { message?: unknown; stack?: unknown } | null;
  const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(e);
  const stack = err && typeof err === "object" && typeof err.stack === "string" ? err.stack.split("\n").slice(0, 8).join("\n") : "";
  return stack ? `${kind}: ${msg}\n${stack}` : `${kind}: ${msg}`;
}

function log(line: string) {
  try {
    void invoke("frontend_error_log", { text: line }).catch(() => {});
  } catch {
    // no backend (a harness page): the console has it
  }
}

/** True when Svelte still runs effects: poke the probe and see the watcher answer within `ms`. */
export function alive(ms = 1000): Promise<boolean> {
  const want = untrack(() => probe) + 1;
  probe = want;
  return new Promise((done) => {
    const t0 = performance.now();
    const look = () => {
      if (seen >= want) return done(true);
      if (performance.now() - t0 >= ms) return done(false);
      setTimeout(look, 50);
    };
    setTimeout(look, 50);
  });
}

/** The bar, in plain DOM (Svelte is what stopped). Idempotent. */
export function showDeadBar(doc: Document = document): void {
  if (doc.getElementById(BAR_ID)) return;
  const bar = doc.createElement("div");
  bar.id = BAR_ID;
  bar.setAttribute("role", "alert");
  bar.style.cssText =
    "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;align-items:center;padding:8px 10px 8px 14px;border-radius:8px;background:#2a1d12;color:#f3e3cc;border:1px solid #c98a3c;font:13px/1.3 -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px #0008";
  const text = doc.createElement("span");
  text.textContent = "Nightloom hit an error and stopped updating. Your drafts are kept.";
  const btn = doc.createElement("button");
  btn.textContent = "Reload view";
  btn.style.cssText = "font:inherit;font-weight:600;padding:4px 10px;border-radius:6px;border:1px solid #c98a3c;background:#c98a3c;color:#1b130b;cursor:pointer;white-space:nowrap";
  btn.onclick = () => location.reload();
  bar.append(text, btn);
  doc.body.append(bar);
}

let dead = false;
async function check(why: string) {
  if (checking || dead) return;
  checking = true;
  try {
    // Twice, the second longer, so a busy moment is never read as a dead window.
    if (!(await alive(1500)) && !(await alive(3000))) {
      dead = true;
      log(`window: Svelte stopped running the App's effects (${why}) — offered Reload view`);
      showDeadBar();
    }
  } finally {
    checking = false;
  }
}

async function after(kind: string, e: unknown) {
  log(errorLine(kind, e));
  // Let the failed flush settle first: a one-off error is not a dead window.
  await new Promise((r) => setTimeout(r, 300));
  await check(`after an ${kind}`);
}

/**
 * Call from an effect of the App itself (`App.svelte`): the probe must live in the tree that can die. A separate
 * effect root keeps running after the App's tree has stopped (measured on the 874 freeze in the harness).
 */
export function probeWatch(): void {
  seen = probe;
}

/** Install once, before the App mounts. */
export function installErrorWatch(): void {
  if (installed) return;
  installed = true;
  addEventListener("error", (ev) => void after("error", (ev as ErrorEvent).error ?? (ev as ErrorEvent).message));
  // An effect Svelte gives up on (874's effect_update_depth_exceeded) is reported through console.error, not as a
  // window error: those lines are logged too, and a slow heartbeat catches a stop whatever reported it.
  const ce = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    ce(...args);
    const first = args[0];
    const text = first instanceof Error ? `${first.message}` : String(first ?? "");
    if (/svelte/i.test(text)) void after("svelte", first instanceof Error ? first : new Error(text));
  };
  setInterval(() => void check("heartbeat"), 5000);
  addEventListener("unhandledrejection", (ev) => void after("rejection", (ev as PromiseRejectionEvent).reason));
}
