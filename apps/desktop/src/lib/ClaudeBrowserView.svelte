<script lang="ts">
  /**
   * Claude's browser as a tab (nightshift item 508, option A2): a bar —
   * back, forward, reload, the address line (type a URL, Enter goes there),
   * who holds the browser and the Take over / Give back switch — over the
   * live picture of the chat's Playwright browser, letterboxed at its fixed
   * 1280×800 whatever the pane's size, so the page the model reads never
   * changes with his layout.
   *
   * His clicks, double-clicks, right-clicks, wheel and keys go to the page,
   * mapped from the picture to page pixels (`claudeBrowser.ts`). The
   * backend hands him the browser on his first click or key; while he
   * holds it, the model's browser calls wait. Pointer moves are sent only
   * while he holds it, so a hover never takes the browser from Claude.
   *
   * Frames are asked for only while this tab is in front (or in the other
   * pane) and the window is not hidden; a kept tab sent to the back stops
   * watching and keeps its last picture. The address line's half-typed
   * text is kept per chat in view state, so it survives a switch away, a
   * chat switch, the tab falling off its pane's kept list, and a relaunch.
   */
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { tip } from "./tip";
  import * as api from "./api";
  import { isMac } from "./platform";
  import { viewGet, viewSet } from "./viewState";
  import {
    browsers,
    dismissDialog,
    frames,
    phase,
    readStatus,
    setHold,
    startBrowsers,
    watch,
  } from "./claudeBrowser.svelte";
  import {
    MOVE_MS,
    PAGE_H,
    PAGE_W,
    addressKey,
    addressShown,
    addressToUrl,
    buttonName,
    dialogLine,
    holdLine,
    letterbox,
    modifiersOf,
    phaseText,
    routeKey,
    throttle,
    toPage,
    wheelPixels,
  } from "./claudeBrowser";

  let { session, away = false }: { session: string; away?: boolean } = $props();

  const status = $derived(browsers.byChat[session] ?? null);
  const ph = $derived(phase(session));
  const frame = $derived(frames[session]);
  const live = $derived(ph === "live");
  const heldByMe = $derived(live && status?.held_by === "user");
  const dialog = $derived(browsers.dialog[session] ?? null);
  const empty = $derived(phaseText(ph));

  // The chat's status, read once per chat this view is drawn for (events
  // keep it after that).
  $effect(() => {
    void startBrowsers();
    void readStatus(session);
  });

  // Watching: while in front and the window not hidden. The cleanup runs
  // on going to the back, on a chat change and on close — each one a
  // `false` to the backend once nothing else watches.
  let docVisible = $state(typeof document === "undefined" || document.visibilityState !== "hidden");
  $effect(() => {
    const onVis = () => (docVisible = document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  });
  $effect(() => {
    const s = session;
    if (away || !docVisible) return;
    watch(s, true);
    return () => watch(s, false);
  });

  // The address line: his draft (null = none, the page's address shows).
  let draft = $state<string | null>(null);
  let addrError = $state<string | null>(null);
  let addrEl: HTMLInputElement | undefined = $state();
  $effect.pre(() => {
    const v = viewGet(addressKey(session), "");
    draft = v === "" ? null : v;
    addrError = null;
  });
  function onAddrInput(e: Event): void {
    const v = (e.currentTarget as HTMLInputElement).value;
    draft = v;
    addrError = null;
    viewSet(addressKey(session), v, "");
  }
  function clearDraft(): void {
    draft = null;
    addrError = null;
    viewSet(addressKey(session), "", "");
  }
  function onAddrKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      const typed = draft ?? status?.url ?? "";
      const url = addressToUrl(typed);
      if (!url) {
        addrError = `“${typed.trim()}” is not a web address`;
        return;
      }
      clearDraft();
      void nav("goto", url);
      sink?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      clearDraft();
      addrEl?.blur();
    }
  }

  let navError = $state<string | null>(null);
  async function nav(action: api.BrowserNav, url?: string): Promise<void> {
    navError = null;
    try {
      await api.claudeBrowserNav(session, action, url);
    } catch (err) {
      navError = String(err);
    }
  }

  let holding = $state(false);
  async function hold(held: boolean): Promise<void> {
    holding = true;
    navError = null;
    try {
      await setHold(session, held);
    } catch (err) {
      navError = String(err);
    } finally {
      holding = false;
    }
  }

  // The picture.
  let box: HTMLDivElement | undefined = $state();
  let sink: HTMLTextAreaElement | undefined = $state();
  let bw = $state(0);
  let bh = $state(0);
  let focused = $state(false);
  const pic = $derived(letterbox(bw, bh, status?.width || PAGE_W, status?.height || PAGE_H));
  const pw = $derived(status?.width || PAGE_W);
  const phh = $derived(status?.height || PAGE_H);

  function send(input: api.BrowserInput): void {
    if (!live) return;
    api.claudeBrowserInput(session, input).catch(() => {});
  }

  function pointAt(e: MouseEvent): { x: number; y: number } | null {
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return toPage(e.clientX - r.left, e.clientY - r.top, pic, pw, phh);
  }

  function onDown(e: MouseEvent): void {
    if (!live || !pointAt(e)) return;
    // Keep the keyboard here (the sink), and no text selection drag.
    e.preventDefault();
    sink?.focus();
  }
  function onUp(e: MouseEvent): void {
    const p = pointAt(e);
    if (!p || e.detail > 2) return;
    send({ kind: "click", x: p.x, y: p.y, button: buttonName(e.button), clicks: e.detail === 2 ? 2 : 1, modifiers: modifiersOf(e) });
  }
  const mover = throttle((x: number, y: number) => send({ kind: "move", x, y }), MOVE_MS);
  function onMove(e: MouseEvent): void {
    if (!heldByMe) return;
    const p = pointAt(e);
    if (p) mover.call(p.x, p.y);
  }
  let wheelAcc = { x: 0, y: 0, dx: 0, dy: 0 };
  const wheeler = throttle(() => {
    const w = wheelAcc;
    wheelAcc = { x: w.x, y: w.y, dx: 0, dy: 0 };
    if (w.dx !== 0 || w.dy !== 0) send({ kind: "wheel", x: w.x, y: w.y, dx: Math.round(w.dx), dy: Math.round(w.dy) });
  }, MOVE_MS);
  function onWheel(e: WheelEvent): void {
    const p = pointAt(e);
    if (!p || !live) return;
    wheelAcc = {
      x: p.x,
      y: p.y,
      dx: wheelAcc.dx + wheelPixels(e.deltaX, e.deltaMode),
      dy: wheelAcc.dy + wheelPixels(e.deltaY, e.deltaMode),
    };
    wheeler.call();
  }
  $effect(() => () => {
    mover.cancel();
    wheeler.cancel();
  });

  function onKey(e: KeyboardEvent): void {
    const r = routeKey(e, isMac);
    if (r.route !== "page") return;
    e.preventDefault();
    e.stopPropagation();
    send(r.input);
  }
  function onPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    e.preventDefault();
    if (text) send({ kind: "text", text });
  }
  function onCompositionEnd(e: CompositionEvent): void {
    if (e.data) send({ kind: "text", text: e.data });
    void tick().then(() => {
      if (sink) sink.value = "";
    });
  }
  function onSinkInput(e: Event): void {
    const ie = e as InputEvent;
    if (ie.isComposing) return;
    // Text that came by no key we sent (dictation, the character viewer).
    if (ie.data && ie.inputType === "insertText") send({ kind: "text", text: ie.data });
    if (sink) sink.value = "";
  }

  const shownAddr = $derived(addressShown(draft, status?.url));
</script>

<div class="cb" data-phase={ph} data-held={status?.held_by ?? ""}>
  <div class="cb-bar">
    <button class="wb" use:tip={"Back"} aria-label="Back" disabled={!live} onclick={() => void nav("back")}><Icon name="chevl" size={13} /></button>
    <button class="wb" use:tip={"Forward"} aria-label="Forward" disabled={!live} onclick={() => void nav("forward")}><Icon name="chevr" size={13} /></button>
    <button class="wb" use:tip={"Reload"} aria-label="Reload" disabled={!live} onclick={() => void nav("reload")}><Icon name="refresh" size={12} /></button>
    <input
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      class="addr"
      class:draft={draft !== null}
      class:bad={addrError !== null}
      bind:this={addrEl}
      value={shownAddr}
      disabled={!live}
      placeholder={live ? "Type an address, Enter to go" : ""}
      aria-label="Address"
      use:tip={draft !== null ? `Your unsent address — Enter goes there, Esc puts back ${status?.url ?? "the page's"}` : "The page's address — type one and press Enter to go there"}
      oninput={onAddrInput}
      onkeydown={onAddrKey}
      onfocus={(e) => e.currentTarget.select()}
    />
    {#if live && (status?.pages ?? 1) > 1}
      <span class="pages mono" use:tip={"The page opened others (a link in a new window); the newest is shown"}>{status?.pages} pages</span>
    {/if}
    {#if live}
      <span class="who mono" data-who={status?.held_by}>{heldByMe ? "you" : "Claude"}</span>
      {#if heldByMe}
        <button class="wb hold" disabled={holding} use:tip={"Hand the browser back to Claude; its waiting calls go on"} onclick={() => void hold(false)}>Give back</button>
      {:else}
        <button class="wb hold" disabled={holding} use:tip={"Take the browser from Claude; its browser calls wait until you give it back"} onclick={() => void hold(true)}>Take over</button>
      {/if}
    {/if}
  </div>
  {#if live}
    <div class="cb-line" role="status" class:mine={heldByMe}>{holdLine(status, ph)}</div>
  {/if}
  {#if addrError || navError}
    <div class="cb-line err" role="alert">{addrError ?? navError}</div>
  {/if}
  {#if dialog}
    <div class="cb-line notice" role="status">
      <span class="notice-text">{dialogLine(dialog)}</span>
      <button class="wb x" aria-label="Dismiss" onclick={() => dismissDialog(session)}>×</button>
    </div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="cb-pic"
    class:focused
    bind:this={box}
    bind:clientWidth={bw}
    bind:clientHeight={bh}
    onmousedown={onDown}
    onmouseup={onUp}
    onmousemove={onMove}
    onwheel={onWheel}
    oncontextmenu={(e) => {
      if (pointAt(e)) e.preventDefault();
    }}
  >
    {#if frame && ph !== "none"}
      <img
        class="frame"
        class:stale={!live}
        src={frame.src}
        alt={status?.title ? `Claude's browser: ${status.title}` : "Claude's browser"}
        draggable="false"
        style:left="{pic.x}px"
        style:top="{pic.y}px"
        style:width="{pic.w}px"
        style:height="{pic.h}px"
      />
    {/if}
    {#if !frame || ph !== "live"}
      <div class="cb-empty" class:over={!!frame && ph !== "none"}>
        <div class="cb-empty-title">{empty.title}</div>
        {#if empty.body}<p>{empty.body}</p>{/if}
      </div>
    {/if}
    {#if live}
      <textarea
        class="sink"
        bind:this={sink}
        aria-label="Keys to Claude's browser"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        tabindex="0"
        style:left="{pic.x}px"
        style:top="{pic.y}px"
        style:width="{pic.w}px"
        style:height="{pic.h}px"
        onfocus={() => (focused = true)}
        onblur={() => (focused = false)}
        onkeydown={onKey}
        onpaste={onPaste}
        oncompositionend={onCompositionEnd}
        oninput={onSinkInput}
      ></textarea>
    {/if}
  </div>
</div>

<style>
  .cb {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .cb-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--sheet);
    flex: none;
    min-width: 0;
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
    flex: none;
  }
  .wb:hover:not(:disabled) {
    background: var(--hover, rgba(255, 255, 255, 0.06));
    color: var(--ink);
  }
  .wb:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .wb.hold {
    border-color: var(--line2);
    color: var(--ink);
  }
  .addr {
    flex: 1;
    min-width: 60px;
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
  .addr:focus,
  .addr.draft {
    outline: none;
    border-color: var(--line2);
    color: var(--ink);
  }
  .addr.bad {
    border-color: var(--failed);
  }
  .pages {
    flex: none;
    font-size: 11px;
    color: var(--dim);
  }
  .who {
    flex: none;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--line2);
    color: var(--dim);
  }
  .who[data-who="user"] {
    color: var(--accent-ink);
    border-color: var(--accent-ink);
  }
  .cb-line {
    flex: none;
    padding: 4px 10px;
    font-size: 12px;
    color: var(--dim);
    border-bottom: 1px solid var(--line);
    background: var(--sheet);
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .cb-line.mine {
    color: var(--accent-ink);
  }
  .cb-line.err {
    color: var(--failed);
  }
  .notice-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wb.x {
    height: 18px;
    min-width: 18px;
  }
  .cb-pic {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--well, #111);
  }
  .frame {
    position: absolute;
    display: block;
    user-select: none;
    -webkit-user-select: none;
    pointer-events: none;
    background: #fff;
  }
  .frame.stale {
    opacity: 0.35;
  }
  .cb-pic.focused .frame {
    outline: 2px solid var(--accent-ink);
    outline-offset: -2px;
  }
  .sink {
    position: absolute;
    opacity: 0;
    border: 0;
    padding: 0;
    margin: 0;
    resize: none;
    background: transparent;
    color: transparent;
    caret-color: transparent;
    pointer-events: none;
    outline: none;
  }
  .cb-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 24px;
    text-align: center;
    color: var(--dim);
    font-size: 13px;
  }
  .cb-empty.over {
    background: color-mix(in srgb, var(--paper) 55%, transparent);
  }
  .cb-empty-title {
    color: var(--ink);
    font-size: 14px;
  }
  .cb-empty p {
    max-width: 460px;
    margin: 0;
    line-height: 1.45;
  }
</style>
