<script lang="ts">
  /**
   * A web tab's view (nightshift backlog 172): a slim bar — back,
   * forward, reload, the address (read-only: selectable and copyable,
   * never typed into; "not a search engine", his words) and Open in
   * browser — over an empty box the page's child webview is laid on.
   *
   * The webview is native, so it draws above every HTML layer. Each frame
   * this measures the box and tells Rust where the page goes, and hides
   * the page instead while a drag is on (the strips and pane halves must
   * take the drop) or while a dialog, menu or popover overlaps it. The
   * page is hidden, not closed, when the tab goes to the back; it closes
   * with its tab (`closeOrphans`).
   */
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import Icon from "./Icon.svelte";
  import { app } from "./state.svelte";
  import { currentZoom, zoomMechanism } from "./zoom";
  import { OVERLAY_SELECTOR, overlaps } from "./extlink";
  import { openInBrowser, openPage, placePage, web, webLabel } from "./webtabs.svelte";

  let { tabId, content }: { tabId: string; content: { kind: "web"; url: string; title?: string } } = $props();

  let box: HTMLDivElement | undefined = $state();
  const label = $derived(webLabel(tabId));
  const loading = $derived(web.live[label]?.loading ?? true);
  let failed = $state<string | null>(null);

  function nav(action: "back" | "forward" | "reload"): void {
    invoke("web_nav", { label, action }).catch(() => {});
  }

  onMount(() => {
    const me = label;
    let frame = 0;
    let last = "";
    let opened = false;
    let dead = false;
    let dragging = false;
    const onDragStart = () => (dragging = true);
    const onDragEnd = () => (dragging = false);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("dragend", onDragEnd, true);
    document.addEventListener("drop", onDragEnd, true);

    const covered = (r: DOMRect): boolean => {
      for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
        if (box && (box.contains(el) || el.contains(box))) continue;
        const o = el.getBoundingClientRect();
        if (o.width > 0 && o.height > 0 && overlaps(o, r)) return true;
      }
      return false;
    };

    const tick = () => {
      if (dead || !box) return;
      const r = box.getBoundingClientRect();
      // Page zoom (backlog 108) scales CSS pixels; the webview is placed in
      // the window's points.
      const z = zoomMechanism() === "webview" ? currentZoom() : 1;
      const hide =
        dragging ||
        app.draggingTab !== null ||
        app.draggingContent !== null ||
        app.draggingTerm ||
        r.width < 2 ||
        r.height < 2 ||
        covered(r);
      const x = Math.round(r.left * z);
      const y = Math.round(r.top * z);
      const w = Math.round(r.width * z);
      const h = Math.round(r.height * z);
      // The page's own height tells Rust how tall the title bar above it
      // is (webtab.rs, `chrome_height`); it changes with full screen.
      const vh = Math.round(window.innerHeight * z);
      const key = hide ? "hidden" : `${x},${y},${w},${h},${vh}`;
      if (key !== last) {
        last = key;
        if (!opened && !hide) {
          opened = true;
          openPage(me, { url: content.url, x, y, w, h, vh }).catch((err) => {
            failed = String(err);
            last = "";
          });
        } else if (opened) {
          placePage(me, { x, y, w, h, vh, visible: !hide });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      dead = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("dragstart", onDragStart, true);
      document.removeEventListener("dragend", onDragEnd, true);
      document.removeEventListener("drop", onDragEnd, true);
      // To the back, not closed: the tab may come forward again, the page
      // where he left it.
      if (opened) placePage(me, { x: 0, y: 0, w: 1, h: 1, vh: 0, visible: false });
    };
  });
</script>

<div class="web">
  <div class="web-bar">
    <button class="wb" title="Back" aria-label="Back" onclick={() => nav("back")}><Icon name="chevl" size={13} /></button>
    <button class="wb" title="Forward" aria-label="Forward" onclick={() => nav("forward")}><Icon name="chevr" size={13} /></button>
    <button class="wb" title="Reload" aria-label="Reload" onclick={() => nav("reload")}><Icon name="refresh" size={12} /></button>
    <input
      class="addr"
      readonly
      value={content.url}
      aria-label="Address"
      title="The page's address — select to copy"
      onfocus={(e) => e.currentTarget.select()}
    />
    {#if loading}<span class="spin" title="Loading">…</span>{/if}
    <button class="wb open" title="Open this page in your browser" onclick={() => openInBrowser(content.url)}>
      <Icon name="ext" size={12} /><span>Open in browser</span>
    </button>
  </div>
  <div class="web-page" bind:this={box}>
    {#if failed}
      <p class="web-failed">This page could not open here: {failed}</p>
    {/if}
  </div>
</div>

<style>
  .web {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .web-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--sheet);
    flex: none;
  }
  .wb {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    min-width: 24px;
    justify-content: center;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--dim);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .wb:hover {
    background: var(--hover, rgba(255, 255, 255, 0.06));
    color: var(--ink);
  }
  .wb.open {
    border-color: var(--line2);
  }
  .addr {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 5px;
    background: var(--paper);
    color: var(--dim);
    font: inherit;
    font-size: 12px;
    text-overflow: ellipsis;
  }
  .addr:focus {
    outline: none;
    border-color: var(--line2);
    color: var(--ink);
  }
  .spin {
    color: var(--dim);
    font-size: 12px;
  }
  .web-page {
    position: relative;
    flex: 1;
    min-height: 0;
    background: #fff;
  }
  .web-failed {
    margin: 24px;
    color: #333;
    font-size: 13px;
  }
</style>
