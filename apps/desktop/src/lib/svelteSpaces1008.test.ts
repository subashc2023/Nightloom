/*
 * Item 1008 (verify sweep 2): the aside's cache chip read "84kcached". Svelte 5 drops whitespace at the start and
 * end of an element's content, so `{n}<span> cached</span>` draws "84kcached". The class, swept: every element
 * in the app (desktop and phone, main chat and asides) parsed as the compiler parses it — none may start or end
 * its words with a literal space; write `{" "}` instead. (The render of the chip itself: aside1008.dom.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { parse, compile } from "svelte/compiler";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".svelte")) out.push(p);
  }
  return out;
}

type N = { type?: string; name?: string; data?: string; start?: number; fragment?: { nodes: N[] } } & Record<string, unknown>;

describe("1008: no words lose their space at an element's edge", () => {
  it("the compiler drops a leading space inside an element (why the sweep exists)", () => {
    const out = compile('<span>{n}<span class="w"> cached</span></span><b>{n}<i>{" "}cached</i></b>', { generate: "server" }).js.code;
    expect(out).toContain('<span class="w">cached</span>');
    expect(out).toMatch(/<i> cached<\/i>/);
  });

  it("every .svelte file under src/", () => {
    const files = walk(join(__dirname, ".."));
    expect(files.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const line = (at: number) => src.slice(0, at).split("\n").length;
      const visit = (n: unknown) => {
        if (!n || typeof n !== "object") return;
        const node = n as N;
        if (node.type === "RegularElement" && node.fragment) {
          const ns = node.fragment.nodes;
          const first = ns[0];
          const last = ns[ns.length - 1];
          if (first?.type === "Text" && /^[ \t]+\S/.test(first.data ?? "")) bad.push(`${f}:${line(first.start ?? 0)} <${node.name}>`);
          if (last?.type === "Text" && /\S[ \t]+$/.test(last.data ?? "")) bad.push(`${f}:${line(last.start ?? 0)} <${node.name}>`);
        }
        for (const [k, v] of Object.entries(node)) {
          if (k === "parent") continue;
          if (Array.isArray(v)) v.forEach(visit);
          else if (v && typeof v === "object") visit(v);
        }
      };
      visit(parse(src, { modern: true }).fragment);
    }
    expect(bad).toEqual([]);
  }, 60_000);
});
