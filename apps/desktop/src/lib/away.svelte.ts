/**
 * Whether he is looking at Nightloom (nightshift backlog 347, 2026-10-12).
 *
 * His words: he sends a message, switches to a browser or another window
 * while the reply cooks, and comes back to the chat scrolled to the very
 * bottom. The transcript followed the stream to its foot whether or not
 * anyone was watching. Now it follows only while the window is his: while
 * `presence.away` is true the follow-the-bottom effect leaves the view
 * where it is (`Transcript.svelte`), so the refocus finds his place.
 *
 * Away is the **native window's** focus where there is one (Tauri's
 * `onFocusChanged`), not the document's: a web tab's child webview takes
 * the keyboard inside a Nightloom window that is still in front
 * (`webtabs.svelte.ts`), and the document's `blur` fires then — a chat in
 * the other pane should keep following. Outside the app (the dev harness,
 * a browser) the window's `blur` / `focus` are the signal. A hidden
 * document (minimised, another Space, the screen locked) is away on either.
 *
 * Starts as not away: a start that guessed wrong would stop the follow for
 * someone looking, which is the worse error; the first event corrects it.
 */

export const presence = $state({ away: false });

let started = false;
let windowFocused = true;

const awayListeners: Array<() => void> = [];

/** Called each time he leaves (away turns true) — the held needs-you
 *  banner (nightshift backlog 373) posts then. */
export function onAway(cb: () => void): void {
  awayListeners.push(cb);
}

function update(): void {
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const was = presence.away;
  presence.away = hidden || !windowFocused;
  if (presence.away && !was) for (const cb of awayListeners) cb();
}

/** For tests and the harness: what the listeners would have set. */
export function setWindowFocused(focused: boolean): void {
  windowFocused = focused;
  update();
}

/** Starts the listeners, once per page. */
export function watchPresence(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  document.addEventListener("visibilitychange", update);
  const tauri = "__TAURI_INTERNALS__" in window;
  if (tauri) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(({ payload }) => setWindowFocused(payload)))
      .catch(() => {
        // No window API: fall back to the document's own events.
        window.addEventListener("blur", () => setWindowFocused(false));
        window.addEventListener("focus", () => setWindowFocused(true));
      });
  } else {
    window.addEventListener("blur", () => setWindowFocused(false));
    window.addEventListener("focus", () => setWindowFocused(true));
  }
}
