// The window's first script line, in the startup log (item 622b, finding 4 of
// item 622). `main.ts` imports this module before anything else, so ES module
// order runs it before every other module of the bundle is evaluated — after
// the bundle has been fetched and parsed, which is the cost the mark is for.
//
// The line reads `window first_script 0 ms page+<N> ms`: stamped by the
// backend as the mark arrives, and N is `performance.now()` here — the ms
// since the web view began loading the page. Beside the backend's
// `rust webview_created` line it splits the ~2 s before `window launch`:
// process start → the web view built, the page's load and parse, and
// (to `window launch`) evaluating the rest of the bundle.
import { invoke } from "@tauri-apps/api/core";

/** `performance.now()` at the first line the window ran. */
export const FIRST_LINE_MS = performance.now();

/** The mark's detail: `page+<N> ms`, N rounded. Pure, for the suite. */
export function firstScriptDetail(pageMs: number): string {
  return `page+${Math.round(Math.max(0, pageMs))} ms`;
}

// Outside the app (a plain browser, the suite) there is no backend to tell.
if (typeof globalThis === "object" && "__TAURI_INTERNALS__" in globalThis) {
  void invoke("startup_mark", { step: "first_script", ms: 0, detail: firstScriptDetail(FIRST_LINE_MS) }).catch(() => {});
}
