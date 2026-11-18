import { afterEach, beforeEach, describe, expect, it } from "vitest";
import promptSrc from "../../../../crates/nightloom-service/src/prompt.rs?raw";
import packageSrc from "../../package.json?raw";
import { HTML_CSP, HTML_CSP_KIT, pageDocument } from "./htmlPage";
import { FALLBACK_THEME, KIT_NAMES, KIT_VERSIONS, inlineScript, kitName, kitNames, loadKit, withKit } from "./pageKit";

describe("item 770: the kit a page loads by name", () => {
  it("reads the names a page asks for, in any quoting, each once", () => {
    const page = `<script src="kit:vega-lite"></script><script src='kit:mermaid' defer></script><script src=kit:katex></script><SCRIPT type="text/javascript" SRC="kit:Three"></SCRIPT><script src="kit:vega"></script>`;
    expect(kitNames(page)).toEqual({ names: ["vega-lite", "mermaid", "katex", "three"], unknown: [] });
    expect(kitNames(`<script src="kit:d3"></script><script src="https://cdn.example/x.js"></script>`)).toEqual({ names: [], unknown: ["d3"] });
    expect(kitNames("<p>no kit</p>")).toEqual({ names: [], unknown: [] });
    expect(kitName("three.js")).toBe("three");
    expect(kitName("jquery")).toBeNull();
  });

  it("writes the library into the page in place of the tag: no src left to fetch", () => {
    const page = `<!doctype html><div id="c"></div><script src="kit:vega-lite"></script><script>nightloom.chart("#c", {})</script>`;
    const out = withKit(page, { "vega-lite": { js: "window.vega={};window.vegaLite={};window.vegaEmbed=function(){};" } }, FALLBACK_THEME);
    expect(out).not.toMatch(/kit:/);
    expect(out).not.toMatch(/<script[^>]*\bsrc=/i);
    expect(out).toContain("window.vegaEmbed=function(){};");
    expect(out).toContain("n.chart=function");
    // The page's own script still follows the library.
    expect(out.indexOf("window.vegaEmbed=")).toBeLessThan(out.indexOf('nightloom.chart("#c"'));
  });

  it("loads a library once however often it is named, and its stylesheet with it", () => {
    const out = withKit(`<script src="kit:katex"></script><script src="kit:katex"></script>`, { katex: { js: "var K=1;", css: ".katex{}</style><script>x" } });
    expect(out.match(/var K=1;/g)).toHaveLength(1);
    expect(out).toContain("<style>.katex{}<\\/style><script>x</style>");
  });

  it("says so when a name is not in the kit or did not load, rather than drawing a blank", () => {
    expect(withKit(`<script src="kit:d3"></script>`, {})).toContain('kind:"error",text:"No kit library is named d3; the kit has vega-lite, mermaid, katex, three."');
    expect(withKit(`<script src="kit:three"></script>`, {})).toContain('kind:"error",text:"The kit library three could not be loaded."');
  });

  it("keeps a library's text from ending its script element or opening a comment", () => {
    const js = `var a="</script>",b="</SCRIPT x",c=/<!--/,d="<script>";`;
    const out = inlineScript(js);
    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("<!--");
    // The escapes read back as the same characters.
    const back = new Function(`${out};return [a,b,c.test("x<!--y"),d];`)() as unknown[];
    expect(back).toEqual(["</script>", "</SCRIPT x", true, "<script>"]);
  });

  it("gives a page that loads the kit a policy that still reaches no network", () => {
    const doc = pageDocument(withKit(`<script src="kit:three"></script>`, { three: { js: "var THREE={};" } }), "dark", { kit: true });
    expect(doc).toContain(HTML_CSP_KIT);
    expect(HTML_CSP_KIT).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    expect(HTML_CSP_KIT.replace(" 'unsafe-eval'", "")).toBe(HTML_CSP);
    expect(HTML_CSP_KIT).toContain("connect-src 'none'");
    expect(HTML_CSP_KIT).not.toMatch(/https?:|\*|'self'/);
    // A page with no kit keeps 819's policy.
    expect(pageDocument("<p>x</p>", "dark")).toContain(`content="${HTML_CSP}"`);
  });

  it("pins the kit's versions, and the instructions name exactly the kit's names", () => {
    const deps = (JSON.parse(packageSrc) as { dependencies: Record<string, string> }).dependencies;
    for (const p of ["vega", "vega-lite", "vega-embed", "mermaid", "three"]) expect(deps[p], p).toMatch(/^\d+\.\d+\.\d+$/);
    expect(KIT_VERSIONS["vega-lite"]).toBe(deps["vega-lite"]);
    expect(KIT_VERSIONS.mermaid).toBe(deps.mermaid);
    expect(KIT_VERSIONS.three).toBe(deps.three);
    const note = /pub const PAGE_NOTE: &str = "([^\n]*)";/.exec(promptSrc)![1];
    for (const n of KIT_NAMES) expect(note, n).toContain(`kit:${n}`);
    expect(note.match(/kit:[a-z-]+/g)!.sort()).toEqual(KIT_NAMES.map((n) => `kit:${n}`).sort());
  });
});

describe("item 770: the kit loads with the network blocked", () => {
  // Every way a script reaches the network is made to throw and counted; the libraries are then read from the
  // bundle (the same modules the app ships) and run. Any load from a server would show here.
  const g = globalThis as unknown as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  let calls: string[] = [];
  beforeEach(() => {
    calls = [];
    for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"]) {
      kept[k] = g[k];
      g[k] = function (...a: unknown[]) {
        calls.push(`${k}(${String(a[0])})`);
        throw new Error(`network blocked: ${k}`);
      };
    }
  });
  afterEach(() => {
    for (const k of Object.keys(kept)) g[k] = kept[k];
  });

  it("every library is in the bundle, whole, and names no script to fetch", async () => {
    for (const name of KIT_NAMES) {
      const src = await loadKit(name);
      expect(src.js.length, name).toBeGreaterThan(50_000);
      // No loader left in it: nothing imports a URL or adds a script element pointing at one.
      expect(src.js, name).not.toMatch(/import\s*\(\s*["']https?:/);
      expect(src.js, name).not.toMatch(/\.src\s*=\s*["']https?:/);
      if (src.css) expect(src.css.match(/url\((?!data:)/g), `${name} css`).toBeNull();
    }
    expect((await loadKit("katex")).css!.match(/url\(data:font\/woff2;base64,/g)!.length).toBe(20);
    expect(calls).toEqual([]);
  });

  it("Vega-Lite compiles and draws a chart with no network call", async () => {
    const { js } = await loadKit("vega-lite");
    (0, eval)(js);
    const vega = g.vega as { parse: (s: unknown) => unknown; View: new (r: unknown, o: unknown) => { toSVG: () => Promise<string> } };
    const vegaLite = g.vegaLite as { compile: (s: unknown) => { spec: unknown } };
    expect(typeof g.vegaEmbed).toBe("function");
    const spec = {
      data: { values: [{ a: "A", b: 28 }, { a: "B", b: 55 }, { a: "C", b: 43 }] },
      mark: "bar",
      encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } },
    };
    const svg = await new vega.View(vega.parse(vegaLite.compile(spec).spec), { renderer: "none" }).toSVG();
    expect(svg).toContain("<svg");
    expect(svg.match(/<path/g)!.length).toBeGreaterThanOrEqual(3);
    expect(calls).toEqual([]);
  });

  it("KaTeX typesets and three.js builds a scene with no network call", async () => {
    (0, eval)((await loadKit("katex")).js);
    const katex = g.katex as { renderToString: (t: string) => string };
    expect(katex.renderToString("\\frac{a}{b}")).toContain("mfrac");
    expect(typeof g.renderMathInElement).toBe("function");
    (0, eval)((await loadKit("three")).js);
    const THREE = g.THREE as { Scene: new () => { add: (o: unknown) => void; children: unknown[] }; Mesh: new (a: unknown, b: unknown) => unknown; BoxGeometry: new () => unknown; MeshBasicMaterial: new () => unknown; OrbitControls: unknown; REVISION: string };
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    expect(scene.children).toHaveLength(1);
    expect(typeof THREE.OrbitControls).toBe("function");
    expect(calls).toEqual([]);
  });
});
