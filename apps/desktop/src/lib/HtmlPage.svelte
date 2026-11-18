<script lang="ts">
  /**
   * An HTML file as a page (nightshift item 819): the sandboxed frame of
   * `htmlPage.ts`, which says what the page can and cannot do. Shared by the
   * file tab, the note view and the phone's notes sheet; item 770's inline
   * pages are meant to reuse it.
   *
   * `place` keys where the page was scrolled: it is put back when the frame
   * draws again — a Reload, Source and back, the view drawn afresh.
   */
  import { untrack } from "svelte";
  import { HTML_SANDBOX, bridgeMessage, BRIDGE_TAG, pageDocument, pagePlace, setPagePlace, type Scheme } from "./htmlPage";

  let {
    html,
    scheme = "dark",
    place,
    title,
  }: { html: string; scheme?: Scheme; place: string; title: string } = $props();

  let frame = $state<HTMLIFrameElement | null>(null);
  const doc = $derived(pageDocument(html, scheme));
  let blocked = $state(0);
  let lastBlocked = $state("");
  let link = $state<string | null>(null);

  // A new document: what the last one blocked is not this one's.
  $effect(() => {
    void doc;
    untrack(() => {
      blocked = 0;
      lastBlocked = "";
      link = null;
    });
  });

  function onmessage(e: MessageEvent): void {
    if (!frame || e.source !== frame.contentWindow) return;
    const m = bridgeMessage(e.data);
    if (!m) return;
    if (m.kind === "scroll") setPagePlace(place, m.x, m.y);
    else if (m.kind === "blocked") {
      blocked += 1;
      lastBlocked = m.uri;
    }
    else link = m.href;
  }

  function onload(): void {
    const at = pagePlace(place);
    if (at && (at.x || at.y)) frame?.contentWindow?.postMessage({ tag: BRIDGE_TAG, kind: "restore", x: at.x, y: at.y }, "*");
  }
</script>

<svelte:window {onmessage} />

<div class="html-page" style:color-scheme={scheme}>
  <iframe bind:this={frame} class="frame" sandbox={HTML_SANDBOX} srcdoc={doc} {title} {onload}></iframe>
  {#if blocked > 0 || link}
    <div class="strip" role="status">
      {#if link}
        <span class="what">Not followed: <span class="mono">{link}</span> — a page here stays offline.</span>
      {/if}
      {#if blocked > 0}
        <span class="what">{blocked} outside load{blocked === 1 ? "" : "s"} blocked{lastBlocked ? ` (${blocked === 1 ? "" : "last: "}${lastBlocked})` : ""} — a page here stays offline.</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .html-page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--term, var(--well));
  }
  .frame {
    flex: 1;
    min-height: 0;
    width: 100%;
    border: none;
    display: block;
  }
  .strip {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 14px;
    border-top: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--dim);
    background: var(--sheet, var(--bg));
  }
  .mono {
    font-family: var(--mono);
    word-break: break-all;
  }
</style>
