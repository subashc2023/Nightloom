import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Item 797 (point at it): the scoping class names its component —
    // `svelte-<hash>-Composer` rather than `svelte-<hash>` — so the element
    // picker can say which `.svelte` file drew what he pointed at, in a
    // release build too. The hash is Svelte's own default; only the name
    // is added. A component with no <style> has no class, as before.
    cssHash: ({ css, filename, hash, name }) =>
      `svelte-${hash(filename === "(unknown)" ? css : (filename ?? css))}-${name}`,
  },
};
