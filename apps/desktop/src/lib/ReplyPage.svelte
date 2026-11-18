<script lang="ts">
  /**
   * A page inside a reply (nightshift item 770): the card `replyPages.ts`
   * mounts where a reply's ```html page block stands. The page is drawn by
   * `HtmlPage` in its sandbox, as tall as its own content up to a cap,
   * with the app's colours as CSS variables and the kit loadable by name.
   *
   * The card's head: the page's title, Source/Page, Copy (the HTML as
   * written), Reload, Expand (the page over the whole window; Close or
   * Esc), and Hide/Show. Whether a page opens drawn or as this one line
   * is the setting (`replyPagePrefs`); what he chose for a page, and its
   * Source/Page, are kept by the page's content (`viewState`, persisted),
   * so they survive a reload, a tab switch and a rewind that keeps the
   * reply. The frame is made only near the viewport, and at most
   * `MAX_LIVE` at once (`replyPageLive.ts`).
   *
   * The Mac's transcript (both looks), its asides, and the phone share
   * this component.
   */
  import { onDestroy, untrack } from "svelte";
  import HtmlPage from "./HtmlPage.svelte";
  import Icon from "./Icon.svelte";
  import { tip } from "./tip";
  import { viewGet, viewSet } from "./viewState";
  import { replyPagePrefs } from "./replyPagePrefs.svelte";
  import { pageHead } from "./replyPage";
  import { readKitTheme } from "./pageTheme";
  import { kitNames } from "./pageKit";
  import { rest, wake, type LivePage } from "./replyPageLive";
  import type { Scheme } from "./htmlPage";

  let {
    html,
    title,
    pageKey,
    copy,
  }: {
    html: string;
    title: string;
    /** The page's content key (`pageOf`): what its kept choices are filed under. */
    pageKey: string;
    /** Put text on the clipboard, the surface's own way. */
    copy?: (text: string) => void;
  } = $props();

  const scheme: Scheme = typeof document !== "undefined" && document.documentElement.dataset.scheme === "light" ? "light" : "dark";
  const head = pageHead(readKitTheme(null, scheme));
  const kits = $derived(kitNames(html).names);

  // "" = follow the setting; "open" / "closed" = his choice for this page.
  let chosen = $state(viewGet(`page.show:${untrack(() => pageKey)}`, ""));
  let source = $state(viewGet(`page.source:${untrack(() => pageKey)}`, false));
  const open = $derived(chosen === "open" || (chosen === "" && !replyPagePrefs.collapsed));
  function setOpen(on: boolean): void {
    const follows = on === !replyPagePrefs.collapsed;
    chosen = follows ? "" : on ? "open" : "closed";
    viewSet(`page.show:${pageKey}`, chosen, "");
  }
  function setSource(on: boolean): void {
    source = on;
    viewSet(`page.source:${pageKey}`, on, false);
  }

  let card = $state<HTMLElement | null>(null);
  let near = $state(false);
  let awake = $state(false);
  let reloads = $state(0);
  let big = $state(false);
  let copied = $state(false);
  let cap = $state(640);

  const me: LivePage = {
    near: () => near,
    distance: () => {
      if (!card) return Infinity;
      const r = card.getBoundingClientRect();
      return Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
    },
    sleep: () => (awake = false),
  };

  // The frame is made when the card nears the viewport (two screens' margin), and kept until another needs its place.
  $effect(() => {
    if (!card || typeof IntersectionObserver === "undefined") {
      near = true;
      return;
    }
    const io = new IntersectionObserver((all) => (near = all[all.length - 1].isIntersecting), { rootMargin: "900px 0px" });
    io.observe(card);
    return () => io.disconnect();
  });
  const wants = $derived(open && !source);
  $effect(() => {
    if (wants && near && !awake) {
      awake = true;
      cap = Math.max(240, Math.min(640, Math.round(window.innerHeight * 0.7)));
      untrack(() => wake(me));
    } else if (!wants && awake) {
      awake = false;
      untrack(() => rest(me));
    }
  });
  onDestroy(() => rest(me));

  function doCopy(): void {
    if (copy) copy(html);
    else void navigator.clipboard?.writeText(html);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
  function onkey(e: KeyboardEvent): void {
    if (big && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      big = false;
    }
  }
  const lines = $derived(html.split("\n").length);
</script>

<svelte:window onkeydown={onkey} />

<div class="rp" class:closed={!open} bind:this={card} data-reply-page>
  <div class="rp-head">
    <span class="rp-mark"><Icon name="note" size={12} /></span>
    <span class="rp-title" use:tip={"A page this reply wrote. It runs in a sandbox: no network, nothing of the app."}>{title}</span>
    {#each kits as k (k)}<span class="rp-kit">{k}</span>{/each}
    <span class="rp-gap"></span>
    {#if open}
      <button class="rp-btn" class:on={source} use:tip={source ? "Show the page" : "Show the page's HTML"} onclick={() => setSource(!source)}>{source ? "Page" : "Source"}</button>
      <button class="rp-btn" use:tip={"Copy the page's HTML"} onclick={doCopy}>{copied ? "Copied" : "Copy"}</button>
      {#if !source}
        <button class="rp-btn" use:tip={"Draw the page again from the start"} onclick={() => (reloads += 1)}>Reload</button>
        <button class="rp-btn" use:tip={"Show the page over the whole window"} onclick={() => (big = true)}>Expand</button>
      {/if}
      <button class="rp-btn" use:tip={"Fold this page to one line"} onclick={() => setOpen(false)}>Hide</button>
    {:else}
      <span class="rp-meta">{lines} line{lines === 1 ? "" : "s"} of HTML</span>
      <button class="rp-btn" use:tip={"Copy the page's HTML"} onclick={doCopy}>{copied ? "Copied" : "Copy"}</button>
      <button class="rp-btn show" use:tip={"Draw the page here"} onclick={() => setOpen(true)}>Show</button>
    {/if}
  </div>
  {#if open}
    {#if source}
      <pre class="rp-source"><code>{html}</code></pre>
    {:else if awake}
      {#key reloads}
        <HtmlPage {html} {scheme} place={`reply-page:${pageKey}`} {title} fit {cap} {head} />
      {/key}
    {:else}
      <div class="rp-asleep">The page draws when it is on screen.</div>
    {/if}
  {/if}
</div>

{#if big}
  <div class="rp-over" use:portal role="dialog" aria-modal="true" aria-label={`${title}, over the whole window`}>
    <div class="rp-over-head">
      <span class="rp-title">{title}</span>
      <span class="rp-gap"></span>
      <button class="rp-btn" onclick={() => (big = false)}>Close <span class="rp-esc">Esc</span></button>
    </div>
    <div class="rp-over-body">
      <HtmlPage {html} {scheme} place={`reply-page-big:${pageKey}`} {title} {head} />
    </div>
  </div>
{/if}

<style>
  .rp {
    margin: 0.8em 0;
    border: 1px solid var(--line2, var(--line, var(--border)));
    border-radius: var(--r2, 8px);
    background: var(--term, var(--well));
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  /* Jarvis: the lit corner the message box and the question card carry (transparent in Calm and Classic). */
  .rp::before {
    content: "";
    position: absolute;
    top: -1px;
    left: -1px;
    width: 9px;
    height: 9px;
    border-top: 2px solid var(--bracket, transparent);
    border-left: 2px solid var(--bracket, transparent);
    border-top-left-radius: var(--r2, 8px);
    pointer-events: none;
  }
  .rp-head,
  .rp-over-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 5px 8px 5px 10px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--dim);
    background: var(--sheet, var(--bg));
    border-bottom: 1px solid var(--line, var(--border));
  }
  .rp.closed .rp-head {
    border-bottom: none;
  }
  .rp-mark {
    display: inline-flex;
    color: var(--accent);
    flex: none;
  }
  .rp-title {
    color: var(--ink, var(--text));
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .rp-kit,
  .rp-meta {
    flex: none;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 10.5px;
    color: var(--dim);
  }
  .rp-kit {
    border: 1px solid var(--line, var(--border));
    border-radius: 999px;
    padding: 0 6px;
  }
  .rp-gap {
    flex: 1;
    min-width: 4px;
  }
  .rp-btn {
    flex: none;
    font: inherit;
    font-size: 11px;
    color: var(--dim);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    padding: 1px 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .rp-btn:hover,
  .rp-btn.on {
    color: var(--ink, var(--text));
    border-color: var(--line, var(--border));
    background: var(--well);
  }
  .rp-btn.show {
    color: var(--accent-ink, var(--accent));
    border-color: var(--line, var(--border));
  }
  .rp-esc {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 10px;
    opacity: 0.7;
  }
  .rp-source {
    margin: 0;
    padding: 10px 12px;
    max-height: 420px;
    overflow: auto;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px;
    line-height: 1.5;
    color: var(--ink, var(--text));
    background: transparent;
    border: none;
    border-radius: 0;
    white-space: pre;
  }
  .rp-source code {
    font: inherit;
    background: none;
    padding: 0;
    border: none;
  }
  .rp-asleep {
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--dim);
  }
  .rp-over {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    background: var(--paper, var(--bg));
  }
  .rp-over-head {
    padding: 8px 12px;
    font-size: 12.5px;
  }
  .rp-over-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  @media (max-width: 520px) {
    .rp-kit {
      display: none;
    }
  }
</style>
