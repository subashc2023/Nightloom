/**
 * The visual kit (nightshift item 770): libraries shipped inside the app that a page drawn in the sandbox
 * (`htmlPage.ts`) loads by name, with no network. A page writes
 *
 *     <script src="kit:vega-lite"></script>
 *
 * and, before the frame loads, that tag is replaced by the library itself as an inline script (the page's policy
 * allows inline scripts only, and nothing from any server). The names:
 *
 * | name        | what the page gets                                                                    |
 * |-------------|---------------------------------------------------------------------------------------|
 * | `vega-lite` | `vega`, `vegaLite`, `vegaEmbed`, and `nightloom.chart(el, spec)` (themed, no menu)   |
 * | `mermaid`   | `mermaid`, themed; every `<pre class="mermaid">` is drawn on load                     |
 * | `katex`     | `katex`, its stylesheet and fonts; `$…$`, `$$…$$`, `\(…\)`, `\[…\]` typeset on load   |
 * | `three`     | `THREE` (with `THREE.OrbitControls`)                                                  |
 *
 * The sources are made at build time (`kit-plugin.js`) and loaded here on first use, once per window; a page
 * that names no kit loads none of it. `KIT_VERSIONS` is what the model is told (`prompt.rs` `PAGE_NOTE`).
 */
import versions from "virtual:nightloom-kit/versions";
import { BRIDGE_TAG } from "./htmlPage";

export type KitName = "vega-lite" | "mermaid" | "katex" | "three";
export const KIT_NAMES: KitName[] = ["vega-lite", "mermaid", "katex", "three"];
export const KIT_VERSIONS: Record<KitName, string> = {
  "vega-lite": versions["vega-lite"],
  mermaid: versions.mermaid,
  katex: versions.katex,
  three: versions.three,
};

/** Other spellings a page may use for a kit name. */
const ALIAS: Record<string, KitName> = { vega: "vega-lite", vegalite: "vega-lite", "vega-embed": "vega-lite", "three.js": "three", threejs: "three" };

export function kitName(written: string): KitName | null {
  const w = written.trim().toLowerCase();
  if ((KIT_NAMES as string[]).includes(w)) return w as KitName;
  return ALIAS[w] ?? null;
}

/** `<script src="kit:name"></script>`, any quoting, other attributes allowed; the tag's own body is dropped. */
const KIT_TAG = /<script\b[^>]*?\bsrc\s*=\s*(?:"kit:([^"]*)"|'kit:([^']*)'|kit:([^\s>]*))[^>]*>([\s\S]*?)<\/script\s*>/gi;

/** The kit names a page asks for, each once, in order; an unknown name is in `unknown`. */
export function kitNames(html: string): { names: KitName[]; unknown: string[] } {
  const names: KitName[] = [];
  const unknown: string[] = [];
  for (const m of html.matchAll(KIT_TAG)) {
    const written = m[1] ?? m[2] ?? m[3] ?? "";
    const n = kitName(written);
    if (n) {
      if (!names.includes(n)) names.push(n);
    } else if (!unknown.includes(written)) unknown.push(written);
  }
  return { names, unknown };
}

/** One kit library's text: its script, and a stylesheet when it has one. */
export interface KitSource {
  js: string;
  css?: string;
}

const loaders: Record<KitName, () => Promise<KitSource>> = {
  "vega-lite": async () => ({ js: (await import("virtual:nightloom-kit/vega-lite")).default }),
  mermaid: async () => ({ js: (await import("virtual:nightloom-kit/mermaid")).default }),
  katex: async () => {
    const [js, css] = await Promise.all([import("virtual:nightloom-kit/katex"), import("virtual:nightloom-kit/katex-css")]);
    return { js: js.default, css: css.default };
  },
  three: async () => ({ js: (await import("virtual:nightloom-kit/three")).default }),
};

const loaded = new Map<KitName, Promise<KitSource>>();

/** A kit library's source, loaded once. A failed load is forgotten, so the next page tries again. */
export function loadKit(name: KitName): Promise<KitSource> {
  let p = loaded.get(name);
  if (!p) {
    p = loaders[name]();
    loaded.set(name, p);
    p.catch(() => loaded.delete(name));
  }
  return p;
}

/** Text safe inside an inline `<script>`: nothing in it can end the element or open an HTML comment. In a
 *  minified library these sit only in strings and regular expressions, where the escapes mean the same. */
export function inlineScript(js: string): string {
  return js
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/<(s)(cript)/gi, (_, s: string, rest: string) => `<\\x${s.charCodeAt(0).toString(16)}${rest}`)
    .replace(/<!--/g, "<\\x21--");
}

/** The colours a kit library is set up with: the app's own, read where the page is shown. */
export interface KitTheme {
  dark: boolean;
  ink: string;
  dim: string;
  line: string;
  paper: string;
  raised: string;
  accent: string;
  signal: string;
  series: string[];
}

export const FALLBACK_THEME: KitTheme = {
  dark: true,
  ink: "#e9edf2",
  dim: "#939eae",
  line: "#242b35",
  paper: "#0b0d10",
  raised: "#1c212a",
  accent: "#ffb454",
  signal: "#86d8f7",
  series: ["#ffb454", "#86d8f7", "#7cd69a", "#f07f7f", "#c9a0ff", "#e8c063", "#ff7d4f", "#939eae"],
};

/** What runs right after a library, inside the page: its setup in the app's colours. */
function setup(name: KitName, t: KitTheme): string {
  const T = JSON.stringify(t);
  if (name === "vega-lite")
    return `(function(){var t=${T};var axis={domainColor:t.line,gridColor:t.line,tickColor:t.line,labelColor:t.dim,titleColor:t.ink};
var config={background:"transparent",font:"system-ui, -apple-system, sans-serif",view:{stroke:t.line},axis:axis,
legend:{labelColor:t.dim,titleColor:t.ink},title:{color:t.ink,subtitleColor:t.dim},header:{labelColor:t.dim,titleColor:t.ink},
range:{category:t.series},mark:{color:t.series[0]},text:{color:t.ink},rule:{color:t.dim},style:{"guide-label":{fill:t.dim},"guide-title":{fill:t.ink}}};
var n=window.nightloom=window.nightloom||{};n.theme=t;n.vegaConfig=config;
n.chart=function(el,spec,opts){var s=Object.assign({},spec);if(s.width===undefined&&!s.facet&&!s.repeat&&!s.concat&&!s.hconcat&&!s.vconcat)s.width="container";
return vegaEmbed(el,s,Object.assign({actions:false,renderer:"svg",config:config},opts||{}));};})();`;
  if (name === "mermaid")
    return `(function(){var t=${T};mermaid.initialize({startOnLoad:true,securityLevel:"strict",theme:"base",fontFamily:"system-ui, -apple-system, sans-serif",
themeVariables:{darkMode:t.dark,background:t.paper,primaryColor:t.raised,primaryTextColor:t.ink,primaryBorderColor:t.dim,secondaryColor:t.paper,tertiaryColor:t.paper,
lineColor:t.dim,textColor:t.ink,mainBkg:t.raised,nodeBorder:t.dim,clusterBkg:t.paper,clusterBorder:t.line,titleColor:t.ink,edgeLabelBackground:t.paper,
noteBkgColor:t.raised,noteTextColor:t.ink,noteBorderColor:t.line,actorBkg:t.raised,actorBorder:t.dim,actorTextColor:t.ink,signalColor:t.dim,signalTextColor:t.ink,
labelBoxBkgColor:t.raised,labelBoxBorderColor:t.dim,labelTextColor:t.ink,loopTextColor:t.ink,activationBkgColor:t.raised,activationBorderColor:t.dim}});
var n=window.nightloom=window.nightloom||{};n.theme=t;})();`;
  if (name === "katex")
    return `(function(){var n=window.nightloom=window.nightloom||{};n.math=function(el){renderMathInElement(el||document.body,{throwOnError:false,
delimiters:[{left:"$$",right:"$$",display:true},{left:"\\\\[",right:"\\\\]",display:true},{left:"\\\\(",right:"\\\\)",display:false},{left:"$",right:"$",display:false}]});};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){n.math();});else n.math();})();`;
  return `(function(){var n=window.nightloom=window.nightloom||{};n.theme=${T};})();`;
}

/**
 * The page with each kit tag replaced by its library, inline. A name that is not in `sources` (unknown, or its
 * load failed) becomes a script that says so in the frame's error strip (posted to the bridge's listener by
 * name: WebKit hides a thrown error's message from a sandboxed page's `error` event) and on the console.
 */
export function withKit(html: string, sources: Partial<Record<KitName, KitSource>>, theme: KitTheme = FALLBACK_THEME): string {
  const done = new Set<KitName>();
  return html.replace(KIT_TAG, (_tag, a?: string, b?: string, c?: string) => {
    const written = a ?? b ?? c ?? "";
    const name = kitName(written);
    const src = name ? sources[name] : undefined;
    if (!name || !src) {
      const why = name ? `The kit library ${name} could not be loaded.` : `No kit library is named ${written || "(empty)"}; the kit has ${KIT_NAMES.join(", ")}.`;
      const msg = inlineScript(JSON.stringify(why));
      return `<script>try{parent.postMessage({tag:${JSON.stringify(BRIDGE_TAG)},kind:"error",text:${msg}},"*")}catch(e){}console.error(${msg});</script>`;
    }
    // Named twice, loaded once.
    if (done.has(name)) return "";
    done.add(name);
    const css = src.css ? `<style>${src.css.replace(/<\/(style)/gi, "<\\/$1")}</style>` : "";
    return `${css}<script>${inlineScript(src.js)}</script><script>${inlineScript(setup(name, theme))}</script>`;
  });
}
