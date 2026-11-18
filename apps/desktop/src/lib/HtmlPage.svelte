<script lang="ts">
  /**
   * An HTML file as a page (nightshift item 819): the sandboxed frame of
   * `htmlPage.ts`, which says what the page can and cannot do. Shared by the
   * file tab, the note view and the phone's notes sheet; item 770's inline
   * pages are meant to reuse it.
   *
   * `place` keys where the page was scrolled: it is put back when the frame
   * draws again — a Reload, Source and back, the view drawn afresh.
   *
   * Item 770: a page may load the kit by name (`pageKit.ts`) — in every view
   * that uses this component; the libraries are read from the app's own
   * bundle and written into the frame, which waits for them ("Loading…").
   * `fit` is a page inside a reply: the frame is as tall as the page says
   * it is, up to `cap`, and scrolls inside past that; `head` is markup put
   * before the page's own (a reply page's base styles). A script error is
   * named in the strip.
   */
  import { untrack } from "svelte";
  import { HTML_SANDBOX, bridgeMessage, BRIDGE_TAG, fitHeight, pageDocument, pagePlace, setPagePlace, type Scheme } from "./htmlPage";
  import { kitNames, loadKit, withKit, type KitName, type KitSource } from "./pageKit";
  import { readKitTheme } from "./pageTheme";

  let {
    html,
    scheme = "dark",
    place,
    title,
    fit = false,
    cap = 640,
    head = "",
  }: { html: string; scheme?: Scheme; place: string; title: string; fit?: boolean; cap?: number; head?: string } = $props();

  let frame = $state<HTMLIFrameElement | null>(null);
  // The kit libraries this page names, read from the bundle once (pageKit keeps them for the window).
  const needs = $derived(kitNames(html));
  let kit = $state.raw<Partial<Record<KitName, KitSource>>>({});
  let kitFailed = $state.raw<KitName[]>([]);
  $effect(() => {
    for (const name of needs.names) {
      if (untrack(() => kit[name] || kitFailed.includes(name))) continue;
      loadKit(name).then(
        (src) => (kit = { ...kit, [name]: src }),
        () => (kitFailed = [...kitFailed, name]),
      );
    }
  });
  const ready = $derived(needs.names.every((n) => kit[n] || kitFailed.includes(n)));
  const doc = $derived.by(() => {
    if (!ready) return null;
    const uses = needs.names.length > 0 || needs.unknown.length > 0;
    const body = uses ? withKit(html, kit, readKitTheme(null, scheme)) : html;
    // 770 review: 'unsafe-eval' only when a kit library is written in; a page naming only an unknown or failed
    // library gets its error line under 819's policy, unwidened.
    const inlined = needs.names.some((n) => !!kit[n]);
    return pageDocument(body, scheme, { kit: inlined, head });
  });
  let blocked = $state(0);
  let lastBlocked = $state("");
  let link = $state<string | null>(null);
  let error = $state<string | null>(null);
  let errors = $state(0);
  // Item 770: the page's own height, as its bridge reports it (a `fit` frame follows it).
  let reported = $state<number | null>(null);
  const height = $derived(fit ? fitHeight(reported, cap) : null);

  // A new document: what the last one blocked is not this one's.
  $effect(() => {
    void doc;
    untrack(() => {
      blocked = 0;
      lastBlocked = "";
      link = null;
      error = null;
      errors = 0;
      reported = null;
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
    else if (m.kind === "size") reported = m.h;
    else if (m.kind === "error") {
      errors += 1;
      // WebKit gives a sandboxed page's own error event no message ("Script error."); say what is known.
      error ??= /^script error\.?$/i.test(m.text.trim()) ? "a script in the page stopped on an error (the sandbox hides which)" : m.text;
    }
    else link = m.href;
  }

  function onload(): void {
    const at = pagePlace(place);
    if (at && (at.x || at.y)) frame?.contentWindow?.postMessage({ tag: BRIDGE_TAG, kind: "restore", x: at.x, y: at.y }, "*");
  }
</script>

<svelte:window {onmessage} />

<div class="html-page" class:fit style:color-scheme={scheme}>
  {#if doc === null}
    <div class="wait" style:height={height === null ? null : `${Math.min(height, 120)}px`}>Loading {needs.names.join(", ")}…</div>
  {:else}
    <iframe bind:this={frame} class="frame" sandbox={HTML_SANDBOX} srcdoc={doc} {title} {onload} style:height={height === null ? null : `${height}px`}></iframe>
  {/if}
  {#if blocked > 0 || link || error}
    <div class="strip" role="status">
      {#if error}
        <span class="what">Script error{errors > 1 ? ` (first of ${errors})` : ""}: <span class="mono">{error}</span></span>
      {/if}
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
  /* Item 770: a page inside a reply is as tall as its content, not as its pane. */
  .html-page.fit {
    flex: none;
    background: transparent;
  }
  .fit .frame {
    flex: none;
  }
  .wait {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--dim);
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
