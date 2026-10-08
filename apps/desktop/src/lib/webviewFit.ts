/**
 * The page fills the window again after a wake (nightshift backlog 324).
 *
 * `webview_fit.rs` sets the webview's frame back to the window's when they
 * differ; Rust calls it on the wake and on the window's resize, scale and
 * focus events. This is the page's half: when the page becomes visible
 * again (the display slept without the Mac sleeping, which Rust does not
 * see) and on the wake, it asks for the same refit and passes its own
 * `innerWidth`/`innerHeight`, so a page laid out at a stale size is caught
 * even when the frame is right. A refit that finds all well does nothing.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** A second look after the first: a waking display can settle over a few frames. */
export const SECOND_LOOK_MS = 600;

/** Ask Rust to refit, with the page's own size. Never throws. */
export async function refitWebview(trigger: string, win: Window = window): Promise<void> {
  try {
    await invoke("refit_webview", {
      trigger,
      innerWidth: win.innerWidth,
      innerHeight: win.innerHeight,
    });
  } catch {
    // Off Tauri, or no main webview: nothing to refit.
  }
}

let installed = false;

/**
 * Listen for the page becoming visible and for the wake. Once per page;
 * later calls do nothing.
 */
export function installWebviewFit(doc: Document = document, win: Window = window): void {
  if (installed) return;
  installed = true;
  const look = (trigger: string) => {
    void refitWebview(trigger, win);
    win.setTimeout(() => void refitWebview(`${trigger} +${SECOND_LOOK_MS}ms`, win), SECOND_LOOK_MS);
  };
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible") look("visible");
  });
  listen("system-woke", () => look("system-woke page")).catch(() => {
    // Off Tauri: no wake to hear.
  });
}

/** For the tests: forget that the listeners went in. */
export function resetWebviewFitForTests(): void {
  installed = false;
}
