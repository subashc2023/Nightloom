// Item 856 (2026-11-19): the check every Classic/Jarvis twin pair runs. Each
// pair's behaviour lives once, in a logic module both components mount
// (`const T = xLogic(() => props)`); the components keep only markup and CSS.
// This reads each component's structure (Svelte's own parser, not its text)
// and reports:
//   - what the instance script holds beyond imports, `$props()` and the
//     logic call — behaviour that slipped back into one look;
//   - the logic members each look's markup binds to (`T.x`, `use:T.x`), so a
//     pair's test can require the two sets to match, less a named list of
//     look-only members.
import { parse } from "svelte/compiler";

type Node = { type: string; [k: string]: unknown };

export interface TwinShape {
  /** Statements in the instance script other than the allowed three kinds. */
  stray: string[];
  /** The logic members the markup reads, writes or binds. */
  bindings: Set<string>;
}

export function twinShape(source: string, logicName = "T"): TwinShape {
  const ast = parse(source, { modern: true }) as unknown as { instance: { content: { body: Node[] } } | null; fragment: Node };
  const stray: string[] = [];
  for (const st of ast.instance?.content.body ?? []) {
    if (st.type === "ImportDeclaration") continue;
    if (st.type === "VariableDeclaration") {
      const d = (st.declarations as { id: Node & { name?: string }; init: Node | null }[])[0];
      const callee = d.init?.type === "CallExpression" ? (d.init.callee as Node & { name?: string }) : null;
      if (callee?.name === "$props") continue;
      if (d.id.name === logicName && callee?.type === "Identifier") continue;
    }
    stray.push(source.slice(st.start as number, Math.min(st.end as number, (st.start as number) + 80)));
  }
  const bindings = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as Node;
    if (node.type === "MemberExpression") {
      const o = node.object as Node & { name?: string };
      const p = node.property as Node & { name?: string };
      if (o.type === "Identifier" && o.name === logicName && !node.computed && p.name) bindings.add(p.name);
    }
    if (typeof node.name === "string" && /Directive$/.test(node.type) && node.name.startsWith(logicName + ".")) {
      bindings.add(node.name.slice(logicName.length + 1));
    }
    for (const [k, v] of Object.entries(node)) if (k !== "parent" && k !== "metadata" && v && typeof v === "object") walk(v);
  };
  walk(ast.fragment);
  return { stray, bindings };
}

/** Members one look binds that the other does not, less the named look-only ones. */
export function twinDrift(a: Set<string>, b: Set<string>, lookOnly: Iterable<string> = []): { onlyA: string[]; onlyB: string[] } {
  const skip = new Set(lookOnly);
  return {
    onlyA: [...a].filter((x) => !b.has(x) && !skip.has(x)).sort(),
    onlyB: [...b].filter((x) => !a.has(x) && !skip.has(x)).sort(),
  };
}
