// `vitest/config` rather than `vite`, only so the `test` block below type-checks
// — it re-exports vite's own `defineConfig` and changes nothing about the build.
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri expects a fixed dev port and does its own console output.
export default defineConfig({
  plugins: [svelte()],
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
      },
    },
  },
  // The suite covers pure functions only — the projections that hand-mirror
  // backend logic and the parsers around them — so it runs in node rather
  // than a DOM. `setup.ts` supplies the one browser global those modules
  // reach for (localStorage); anything that needs a real document belongs in
  // a different kind of test than this file configures.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
