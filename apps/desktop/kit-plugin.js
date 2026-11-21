// Item 770 — the visual kit a page inside the app may load by name, with no network.
//
// `virtual:nightloom-kit/<name>` is a module whose default export is that library's source as one string
// (`pageKit.ts` writes it into a page's sandboxed frame as an inline script). Built from the exact versions in
// package.json, at build time, from node_modules — nothing is fetched at run time and nothing is checked in:
// - vega-lite: Vega, Vega-Lite and vega-embed, their own minified browser builds, one after the other;
// - mermaid:   its minified browser build;
// - katex:     its minified build, the auto-render add-on, and its stylesheet with the woff2 fonts written in as
//              data: URLs (a page's policy allows fonts from data: only);
// - three:     three.js ships as modules only, so esbuild bundles it (with OrbitControls) to one script that
//              sets `THREE`.
// `virtual:nightloom-kit/versions` is `{ name: version }` for the instructions and the tests.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const PREFIX = "virtual:nightloom-kit/";
// The packages are direct dependencies, so each sits in this folder's node_modules (several hide package.json from resolvers).
const dirOf = (pkg) => join(here, "node_modules", pkg);
const read = (pkg, file) => readFileSync(join(dirOf(pkg), file), "utf8");
const versionOf = (pkg) => JSON.parse(read(pkg, "package.json")).version;

function katexCss() {
  const css = read("katex", "dist/katex.min.css");
  // Each face lists woff2, woff and ttf; only the woff2 is kept, as a data: URL.
  return css.replace(/src:url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\([^)]*\) format\("[a-z0-9]+"\))*/g, (_, name) => {
    const font = readFileSync(join(dirOf("katex"), "dist/fonts", `${name}.woff2`)).toString("base64");
    return `src:url(data:font/woff2;base64,${font}) format("woff2")`;
  });
}

async function three() {
  const out = await build({
    stdin: {
      contents: `export * from "three"; export { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";`,
      resolveDir: here,
      loader: "js",
    },
    bundle: true,
    format: "iife",
    globalName: "THREE",
    minify: true,
    write: false,
    legalComments: "none",
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

const sources = {
  "vega-lite": async () => [read("vega", "build/vega.min.js"), read("vega-lite", "build/vega-lite.min.js"), read("vega-embed", "build/vega-embed.min.js")].join(";\n"),
  mermaid: async () => read("mermaid", "dist/mermaid.min.js"),
  katex: async () => [read("katex", "dist/katex.min.js"), read("katex", "dist/contrib/auto-render.min.js")].join(";\n"),
  "katex-css": async () => katexCss(),
  three,
  versions: async () => ({
    "vega-lite": versionOf("vega-lite"),
    vega: versionOf("vega"),
    "vega-embed": versionOf("vega-embed"),
    mermaid: versionOf("mermaid"),
    katex: versionOf("katex"),
    three: versionOf("three"),
  }),
};

export function nightloomKit() {
  const made = new Map();
  return {
    name: "nightloom-kit",
    resolveId(id) {
      return id.startsWith(PREFIX) ? "\0" + id : null;
    },
    async load(id) {
      if (!id.startsWith("\0" + PREFIX)) return null;
      const name = id.slice(PREFIX.length + 1);
      const make = sources[name];
      if (!make) throw new Error(`nightloom-kit: no kit piece named ${name}`);
      if (!made.has(name)) made.set(name, make());
      return `export default ${JSON.stringify(await made.get(name))};`;
    },
  };
}
