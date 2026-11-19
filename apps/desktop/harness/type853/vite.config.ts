// Item 853 (fix 2): builds harness/type853.html into one script; bin/snap-style snapjs reads window.__result.
//   H9_DEBUG=1 nice -n 15 npx vite build -c harness/type853/vite.config.ts --outDir <dir>
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
      input: resolve(desktop, "harness/type853.html"),
      output: { format: "iife", inlineDynamicImports: true },
    },
  },
});
