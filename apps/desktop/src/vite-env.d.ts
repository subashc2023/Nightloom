/// <reference types="svelte" />
/// <reference types="vite/client" />

// `autocorrect` is a real WebKit attribute (Safari/WKWebView honour it on
// text fields) that Svelte's HTML typings do not list. Declared here so the
// composer can switch macOS autocorrect off (2026-09-16).
declare namespace svelteHTML {
  interface HTMLAttributes<T> {
    autocorrect?: "on" | "off";
  }
}
