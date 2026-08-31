<script lang="ts">
  import * as api from "./api";
  import { app, closeNote, showNote } from "./state.svelte";
  import type { LinkGraph } from "./types";

  /**
   * The vault as a picture: one node per note, one edge per link.
   *
   * Drawn on a canvas with a force simulation written here rather than pulled
   * in, on the same principle as the hand-rolled FNV-1a and the HTML
   * extractor — a graph of a few hundred nodes is a hundred lines of physics,
   * and a layout library is a transitive tree for one view.
   *
   * The graph comes from the backend rather than being built here, because
   * building it means reading every note and the frontend holds none of them.
   * It is also the *same* resolution the model sees, which is the point: a
   * picture that disagreed with the system prompt about what links to what
   * would be worse than no picture.
   */

  interface Node {
    name: string;
    /** How many links touch it, in either direction. Radius follows this:
     *  a hub should be findable without reading every label. */
    degree: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
  }

  let graph = $state<LinkGraph | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let hovered = $state<string | null>(null);

  let canvas = $state<HTMLCanvasElement | null>(null);
  let wrap = $state<HTMLDivElement | null>(null);

  let nodes: Node[] = [];
  let edges: { a: number; b: number }[] = [];
  let index = new Map<string, number>();

  $effect(() => {
    void load();
  });

  async function load() {
    loading = true;
    error = null;
    try {
      graph = await api.knowledgeGraph();
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  /**
   * Build the simulation whenever the graph arrives.
   *
   * Seeded on a circle rather than at random: a random cloud takes far longer
   * to untangle and looks broken while it does, where a ring resolves into
   * clusters within a second. The seed is deterministic, so re-opening the
   * view gives the same picture rather than a new one every time.
   */
  $effect(() => {
    const g = graph;
    if (!g) return;
    index = new Map(g.notes.map((n, i) => [n.name, i]));
    const degree = new Array(g.notes.length).fill(0);
    for (const e of g.edges) {
      degree[e.from]++;
      degree[e.to]++;
    }
    const r = 180;
    nodes = g.notes.map((n, i) => {
      const angle = (i / Math.max(1, g.notes.length)) * Math.PI * 2;
      return {
        name: n.name,
        degree: degree[i],
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: 0,
        vy: 0,
      };
    });
    edges = g.edges.map((e) => ({ a: e.from, b: e.to }));
  });

  /**
   * The simulation and the paint, on one animation frame loop.
   *
   * It stops when the layout settles — a canvas repainting forever behind a
   * window nobody is looking at is a fan spinning up for nothing — and
   * restarts on hover or resize, which are the only things that change what
   * is on screen once it has come to rest.
   */
  $effect(() => {
    const c = canvas;
    const box = wrap;
    if (!c || !box || !graph) return;

    let running = true;
    let frame = 0;
    let energy = 1;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = box.clientWidth * dpr;
      c.height = box.clientHeight * dpr;
      c.style.width = `${box.clientWidth}px`;
      c.style.height = `${box.clientHeight}px`;
      energy = 1;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(box);

    const step = () => {
      if (!running) return;
      if (energy > 0.002) {
        simulate();
        energy *= 0.985;
      }
      paint(c);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });

  /**
   * One tick: repulsion between every pair, a spring along every edge, and a
   * weak pull to the centre so a disconnected note does not drift off screen.
   *
   * O(n²) repulsion, deliberately. A vault large enough for that to matter is
   * one where the picture has stopped being readable anyway, and the honest
   * fix there is filtering rather than a quadtree.
   */
  function simulate() {
    const REPEL = 4000;
    const SPRING = 0.012;
    const REST = 90;
    const CENTRE = 0.002;
    const DAMP = 0.85;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        // Two notes seeded at the same point would divide by zero and fly
        // apart; nudging them is cheaper than a special case downstream.
        if (d2 < 1) {
          dx = (i % 7) - 3 + 0.5;
          dy = (j % 7) - 3 + 0.5;
          d2 = dx * dx + dy * dy;
        }
        const force = REPEL / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
      a.vx -= a.x * CENTRE;
      a.vy -= a.y * CENTRE;
    }

    for (const e of edges) {
      const a = nodes[e.a];
      const b = nodes[e.b];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const pull = (d - REST) * SPRING;
      const fx = (dx / d) * pull;
      const fy = (dy / d) * pull;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const n of nodes) {
      n.vx *= DAMP;
      n.vy *= DAMP;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  function radius(n: Node): number {
    return 4 + Math.min(9, Math.sqrt(n.degree) * 2.4);
  }

  function paint(c: HTMLCanvasElement) {
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, c.width / 2, c.height / 2);
    ctx.clearRect(
      -c.width / (2 * dpr),
      -c.height / (2 * dpr),
      c.width / dpr,
      c.height / dpr,
    );

    const lit = hovered ? index.get(hovered) : undefined;
    const neighbours = new Set<number>();
    if (lit !== undefined) {
      for (const e of edges) {
        if (e.a === lit) neighbours.add(e.b);
        if (e.b === lit) neighbours.add(e.a);
      }
    }

    ctx.lineWidth = 1;
    for (const e of edges) {
      const a = nodes[e.a];
      const b = nodes[e.b];
      if (!a || !b) continue;
      const touching = lit !== undefined && (e.a === lit || e.b === lit);
      ctx.strokeStyle = touching
        ? "rgba(150,130,255,0.75)"
        : lit !== undefined
          ? "rgba(120,110,170,0.10)"
          : "rgba(120,110,170,0.28)";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const near = lit === undefined || i === lit || neighbours.has(i);
      ctx.fillStyle =
        i === lit
          ? "#b3a5ff"
          : near
            ? "rgba(160,150,220,0.9)"
            : "rgba(160,150,220,0.25)";
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2);
      ctx.fill();

      // Labels only where they can be read: every node at rest in a small
      // vault, and only the hovered neighbourhood in a crowded one.
      const label = nodes.length <= 60 || near;
      if (label && (lit === undefined ? nodes.length <= 60 : true)) {
        ctx.fillStyle = i === lit ? "#e8e4ff" : "rgba(200,195,225,0.75)";
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(short(n.name), n.x, n.y - radius(n) - 5);
      }
    }
  }

  /** `rust/async.md` -> `async` — the full path is in the tooltip. */
  function short(name: string): string {
    const base = name.split("/").pop() ?? name;
    return base.replace(/\.md$/i, "");
  }

  /** Canvas coordinates of a pointer event, in simulation space. */
  function at(e: MouseEvent): { x: number; y: number } | null {
    const c = canvas;
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    return {
      x: e.clientX - rect.left - rect.width / 2,
      y: e.clientY - rect.top - rect.height / 2,
    };
  }

  function nodeAt(e: MouseEvent): Node | null {
    const p = at(e);
    if (!p) return null;
    let best: Node | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      // A generous hit radius: these are small targets and the alternative is
      // a picture you cannot click.
      if (d < radius(n) + 8 && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  function onMove(e: MouseEvent) {
    const n = nodeAt(e);
    hovered = n?.name ?? null;
  }

  function onClick(e: MouseEvent) {
    const n = nodeAt(e);
    if (n) showNote("knowledge", n.name);
  }

  const brokenCount = $derived(graph?.broken.length ?? 0);
</script>

<div class="graph">
  <header>
    <button class="back" onclick={closeNote}>← Chat</button>
    <span class="title">Knowledge graph</span>
    {#if graph}
      <span class="meta">
        {graph.notes.length} note{graph.notes.length === 1 ? "" : "s"} ·
        {graph.edges.length} link{graph.edges.length === 1 ? "" : "s"}
        {#if brokenCount > 0}
          · {brokenCount} unresolved
        {/if}
      </span>
    {/if}
    <span class="spacer"></span>
    <button class="ghost" onclick={() => void load()} disabled={loading}>
      {loading ? "Reading…" : "Refresh"}
    </button>
  </header>

  <div class="wrap" bind:this={wrap}>
    {#if error}
      <p class="msg err">{error}</p>
    {:else if loading && !graph}
      <p class="msg">Reading the knowledge base…</p>
    {:else if graph && graph.notes.length === 0}
      <p class="msg">
        Nothing to draw yet. Write a note, link another with
        <code>[[name]]</code>, and both appear here.
      </p>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <canvas
        bind:this={canvas}
        onmousemove={onMove}
        onmouseleave={() => (hovered = null)}
        onclick={onClick}
        title={hovered ?? ""}
      ></canvas>
      {#if hovered}
        <div class="tip">{hovered}</div>
      {/if}
    {/if}
  </div>

  <!-- Unresolved links, listed rather than only counted: a vault accumulates
       them, and this is the one place they can all be seen at once. -->
  {#if graph && brokenCount > 0}
    <div class="broken">
      <span class="label">unresolved</span>
      {#each graph.broken.slice(0, 24) as b (`${b.from}:${b.target}`)}
        <span
          class="chip"
          title="{graph.notes[b.from]?.name ?? '?'} links to {b.target}{b
            .resolution.kind === 'ambiguous'
            ? ' — more than one note has that name'
            : ''}"
        >
          {b.target}{b.resolution.kind === "ambiguous" ? " ⚠" : ""}
        </span>
      {/each}
      {#if brokenCount > 24}
        <span class="more">+{brokenCount - 24}</span>
      {/if}
    </div>
  {/if}

  <footer>
    Every note in <code>{app.knowledge?.dir ?? "the knowledge base"}</code>, and
    the <code>[[links]]</code> between them. Click a node to open it.
  </footer>
</div>

<style>
  .graph {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    flex-shrink: 0;
  }
  .back {
    background: transparent;
    border: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.2rem 0.3rem;
    cursor: pointer;
    border-radius: 5px;
  }
  .back:hover {
    color: var(--text);
  }
  .title {
    font-size: 0.85rem;
  }
  .meta {
    font-size: 0.72rem;
    color: var(--dim);
  }
  .spacer {
    flex: 1;
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
  }
  .ghost:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--dim);
  }
  .ghost:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--bg);
    overflow: hidden;
  }
  canvas {
    display: block;
    cursor: pointer;
  }
  .tip {
    position: absolute;
    left: 0.75rem;
    bottom: 0.75rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 0.2rem 0.5rem;
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--text);
    pointer-events: none;
  }
  .msg {
    margin: 1.5rem 1.2rem;
    color: var(--dim);
    font-size: 0.82rem;
    line-height: 1.55;
  }
  .msg.err {
    color: var(--error);
  }
  .msg code,
  footer code {
    font-family: var(--mono);
  }
  .broken {
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    background: var(--panel);
    padding: 0.4rem 1.2rem;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .label {
    font-size: 0.64rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    opacity: 0.8;
  }
  .chip {
    border: 1px dashed var(--border);
    border-radius: 999px;
    color: var(--dim);
    font-family: var(--mono);
    font-size: 0.7rem;
    padding: 0.1rem 0.5rem;
  }
  .more {
    font-size: 0.7rem;
    color: var(--dim);
  }
  footer {
    flex-shrink: 0;
    padding: 0.5rem 1.2rem;
    border-top: 1px solid var(--border);
    background: var(--panel);
    color: var(--dim);
    font-size: 0.7rem;
    line-height: 1.45;
  }
</style>
