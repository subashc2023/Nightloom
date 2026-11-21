// Item 875: builds harness/reply875.html into one script and one stylesheet (fonts inlined), which
// nightshift-code's bin/inline-page.py then folds into a single self-contained page.
//   nice -n 15 npx vite build -c harness/home845/vite.config.ts --outDir <dir>
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";
import { nightloomKit } from "../../kit-plugin.js";

const desktop = resolve(__dirname, "../..");
export default defineConfig({
  root: resolve(desktop, "harness"),
  base: "./",
  plugins: [svelte({ configFile: resolve(desktop, "svelte.config.js") }), nightloomKit()],
  build: {
    emptyOutDir: true,
    minify: process.env.H9_DEBUG ? false : "esbuild",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: resolve(desktop, "harness/reply875.html"),
      output: { format: "iife", inlineDynamicImports: true },
    },
  },
});
