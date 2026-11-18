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

// Item 770: a kit library's source as one string, made at build time by `kit-plugin.js`.
declare module "virtual:nightloom-kit/versions" {
  const versions: Record<"vega-lite" | "vega" | "vega-embed" | "mermaid" | "katex" | "three", string>;
  export default versions;
}
declare module "virtual:nightloom-kit/*" {
  const source: string;
  export default source;
}
