// `vitest/config` rather than `vite`, only so the `test` block below type-checks
// — it re-exports vite's own `defineConfig` and changes nothing about the build.
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
// Item 770: the visual kit (Vega-Lite, Mermaid, KaTeX, three.js) as strings a page inside the app loads by name.
import { nightloomKit } from "./kit-plugin.js";

// Tauri expects a fixed dev port and does its own console output.
export default defineConfig({
  plugins: [svelte(), nightloomKit()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // The phone page (nightshift backlog 091, Shape B) is a second entry of
  // the same build: `remote.html` lands in `dist/` beside `index.html`,
  // its chunks under `dist/assets/`, and the desktop's listener serves
  // them from the bundle. Nothing about the desktop's own entry changes.
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        remote: "remote.html",
        // Item 795: the Quick Entry box, a third entry (`quick_entry.rs` opens it).
        quick: "quick.html",
      },
    },
  },
  // The suite covers pure functions only — the projections that hand-mirror
  // backend logic and the parsers around them — so it runs in node rather
  // than a DOM. `setup.ts` supplies the one browser global those modules
  // reach for (localStorage); anything that needs a real document belongs in
  // a different kind of test than this file configures.
  //
  // Item 934: the one exception is `*.dom.test.ts` — a real component
  // mounted in happy-dom (the message box's ⌘Z across a chat switch, which
  // no pure test saw). Its own project, because mounting needs Svelte's
  // browser build (`conditions: ["browser"]`); the node suite keeps the
  // server build it has always run on.
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.dom.test.ts"],
          setupFiles: ["src/test/setup.ts"],
        },
      },
      {
        extends: true,
        resolve: { conditions: ["browser"] },
        test: {
          name: "dom",
          environment: "happy-dom",
          include: ["src/**/*.dom.test.ts"],
          setupFiles: ["src/test/domSetup.ts"],
        },
      },
    ],
  },
});
