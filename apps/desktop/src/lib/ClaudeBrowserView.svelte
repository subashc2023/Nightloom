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
   * mapped from the picture to page pixels (`claudeBrowser.ts`) — but only
   * once he has clicked into the picture (item 551: a scroll or a trackpad
   * swipe over it must never reach the page). That click arms the tab and
   * is not passed on; a click outside, Escape, the window losing focus, the
   * tab going to the back or a chat switch disarm it (`InputGate`). The
   * backend hands him the browser on his first click or key; while he
   * holds it, the model's browser calls wait. Pointer moves are sent only
   * while he holds it, so a hover never takes the browser from Claude.
   *
   * Every way out of his takeover hands the browser back (item 552): the
   * last tab watching it going (closed, sent to the back, a chat switch,
   * the window hidden — the backend's `watch(false)`), a turn starting or
   * ending, the browser ending (idle, chat closed, app quit).
   *
   * Frames are asked for only while this tab is in front (or in the other
   * pane) and the window is not hidden; a kept tab sent to the back stops
   * watching and keeps its last picture. The address line's half-typed
   * text is kept per chat in view state, so it survives a switch away, a
   * chat switch, the tab falling off its pane's kept list, and a relaunch.
   *
   * Item 567 (Filament IV stage 10, `f4-browser.png`): while the chat's
   * turn runs, the hold strip carries *Stop Claude* (that chat's turn only,
   * `cancelTurn(session)`), and a step log under the picture lists the
   * turn's last browser calls (`browserSteps.ts`), the running one in the
   * signal colour. Both layouts: they are behaviour, not look.
   */
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { tip } from "./tip";
  import * as api from "./api";
  import { isMac } from "./platform";
  import { viewGet, viewSet } from "./viewState";
  import { app, cancelTurn, runningWork } from "./state.svelte";
  import { liveHost } from "./browse";
  import { browserSteps, sameChat, stopHolds } from "./browserSteps";
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
    addressParts,
    addressShown,
    addressToUrl,
    buttonName,
    dialogLine,
    holdStrip,
    InputGate,
    letterbox,
    modifiersOf,
    phaseText,
    routeKey,
    throttle,
    toPage,
    wheelKind,
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
  // keep it after that) — and again at each edge of a turn, which hands
  // his takeover back to Claude with no event of its own (item 552).
  $effect(() => {
    void app.busy;
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
  // Item 551: armed only by a click into the picture.
  let armed = $state(false);
  const gate = new InputGate((a) => (armed = a));
  $effect(() => {
    void session;
    if (away) gate.disarm("tab-away");
    if (!live) gate.disarm("not-live");
    return () => gate.disarm("chat-switch");
  });
  $effect(() => {
    const onBlur = () => gate.disarm("window-blur");
    const onDownAnywhere = (e: PointerEvent) => {
      if (box && e.target instanceof Node && box.contains(e.target)) return;
      gate.disarm("outside-click");
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onDownAnywhere, true);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onDownAnywhere, true);
    };
  });
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
    // Keep the keyboard here (the sink), and no text selection drag. The
    // first press only arms the tab; its release is not passed on.
    e.preventDefault();
    gate.press();
    sink?.focus();
  }
  function onUp(e: MouseEvent): void {
    const p = pointAt(e);
    if (!p) return;
    if (!gate.release() || e.detail > 2) return;
    send({ kind: "click", x: p.x, y: p.y, button: buttonName(e.button), clicks: e.detail === 2 ? 2 : 1, modifiers: modifiersOf(e) });
  }
  const mover = throttle((x: number, y: number) => send({ kind: "move", x, y }), MOVE_MS);
  function onMove(e: MouseEvent): void {
    if (!gate.allows("move", heldByMe)) return;
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
    // Not armed: the scroll or swipe is his, not the page's — let it be.
    if (!gate.allows(wheelKind(e), heldByMe)) return;
    e.preventDefault();
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
    if (e.key === "Escape" && armed && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      gate.disarm("escape");
      sink?.blur();
      return;
    }
    if (!gate.allows("key", heldByMe)) return;
    const r = routeKey(e, isMac);
    if (r.route !== "page") return;
    e.preventDefault();
    e.stopPropagation();
    send(r.input);
  }
  function onPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    e.preventDefault();
    if (!gate.allows("text", heldByMe)) return;
    if (text) send({ kind: "text", text });
  }
  function onCompositionEnd(e: CompositionEvent): void {
    if (e.data && gate.allows("text", heldByMe)) send({ kind: "text", text: e.data });
    void tick().then(() => {
      if (sink) sink.value = "";
    });
  }
  function onSinkInput(e: Event): void {
    const ie = e as InputEvent;
    if (ie.isComposing) return;
    // Text that came by no key we sent (dictation, the character viewer).
    if (ie.data && ie.inputType === "insertText" && gate.allows("text", heldByMe)) send({ kind: "text", text: ie.data });
    if (sink) sink.value = "";
  }

  const shownAddr = $derived(addressShown(draft, status?.url));
  // Item 550: at rest the address reads as scheme (dim) + the rest; while
  // he edits it, the input shows it whole.
  let addrFocused = $state(false);
  const parts = $derived(addressParts(draft, status?.url));
  const strip = $derived(holdStrip(status, ph));

  // Item 567: the chat's running turn, if any, and its browser calls —
  // read from the state that says what runs (`runningWork`), so the log
  // and Stop are there exactly while the sidebar says the chat runs.
  const turnRow = $derived(
    runningWork().find((r) => (r.kind === "turn" || r.kind === "council") && sameChat(r.session, session)) ?? null,
  );
  const steps = $derived.by(() => {
    void app.liveVersion;
    void app.paneVersion;
    if (!turnRow) return { steps: [], total: 0 };
    const bg = Object.values(app.background).find((b) => b.session === turnRow.session);
    return browserSteps(bg ? bg.live?.segments : liveHost(app).live?.segments);
  });
  // The turn Stop was pressed on, by its start: a new turn (a queued
  // message sent the moment the stopped one ended) or none clears the
  // pressed look — the old effect cleared it only on none (w4 review).
  let pressedOn = $state<{ at: number | null } | null>(null);
  const stopping = $derived(stopHolds(pressedOn, turnRow));
  function stopClaude(): void {
    if (stopping) return;
    const mine = { at: turnRow?.startedAt ?? null };
    pressedOn = mine;
    void cancelTurn(session).catch(() => {
      if (pressedOn === mine) pressedOn = null;
    });
  }
  function openOutside(): void {
    const u = status?.url;
    if (u && /^https?:/.test(u)) void api.openUrl(u).catch(() => {});
  }
</script>

<div class="cb" data-phase={ph} data-held={status?.held_by ?? ""}>
  <div class="cb-bar">
    <button class="nb" use:tip={"Back"} aria-label="Back" disabled={!live} onclick={() => void nav("back")}><Icon name="chevl" size={13} /></button>
    <button class="nb" use:tip={"Forward"} aria-label="Forward" disabled={!live} onclick={() => void nav("forward")}><Icon name="chevr" size={13} /></button>
    <button class="nb" use:tip={"Reload"} aria-label="Reload" disabled={!live} onclick={() => void nav("reload")}><Icon name="refresh" size={12} /></button>
    <div class="addr-wrap" class:draft={draft !== null} class:bad={addrError !== null} class:editing={addrFocused}>
      {#if !addrFocused && parts.scheme}
        <span class="scheme mono" aria-hidden="true">{parts.scheme}</span>
      {/if}
      <input
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        class="addr mono"
        bind:this={addrEl}
        value={addrFocused ? shownAddr : parts.rest}
        disabled={!live}
        placeholder={live ? "Type an address, Enter to go" : ""}
        aria-label="Address"
        use:tip={draft !== null ? `Your unsent address — Enter goes there, Esc puts back ${status?.url ?? "the page's"}` : "The page's address — type one and press Enter to go there"}
        oninput={onAddrInput}
        onkeydown={onAddrKey}
        onfocus={(e) => {
          addrFocused = true;
          const el = e.currentTarget;
          void tick().then(() => el.select());
        }}
        onblur={() => (addrFocused = false)}
      />
    </div>
    {#if live && (status?.pages ?? 1) > 1}
      <span class="pages mono" use:tip={"The page opened others (a link in a new window); the newest is shown"}>{status?.pages} pages</span>
    {/if}
    {#if live && status?.url && /^https?:/.test(status.url)}
      <button class="ns-btn small" use:tip={"Open this address in Chrome. Logins made in Claude's browser stay there; they do not carry over."} onclick={openOutside}
        >Open in Chrome</button
      >
    {/if}
  </div>
  {#if strip}
    <div class="cb-hold" role="status" data-tone={strip.tone}>
      <span class="hold-dot" aria-hidden="true"></span>
      <b class="hold-who">{strip.who}</b>
      <span class="hold-detail">{strip.detail}</span>
      {#if heldByMe}
        <button class="ns-btn small" disabled={holding} use:tip={"Hand the browser back to Claude; its waiting calls go on"} onclick={() => void hold(false)}>Give back</button>
      {:else}
        <button class="ns-btn small" disabled={holding} use:tip={"Take the browser from Claude; its browser calls wait until you give it back"} onclick={() => void hold(true)}>Take over</button>
      {/if}
      {#if turnRow}
        <button
          class="ns-btn small danger cb-stop"
          disabled={stopping}
          use:tip={stopping ? "Stopping… — the reply so far stays" : "Stop this chat's turn; the reply so far and the browser stay"}
          onclick={stopClaude}><i class="stop-sq" aria-hidden="true"></i>{stopping ? "Stopping…" : "Stop Claude"}</button
        >
      {/if}
    </div>
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
  <div class="cb-stage">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="cb-pic"
    class:armed
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
        tabindex="-1"
        style:left="{pic.x}px"
        style:top="{pic.y}px"
        style:width="{pic.w}px"
        style:height="{pic.h}px"
        onblur={() => gate.disarm("focus-left")}
        onkeydown={onKey}
        onpaste={onPaste}
        oncompositionend={onCompositionEnd}
        oninput={onSinkInput}
      ></textarea>
      {#if !armed && frame}
        <div class="arm-hint mono" aria-hidden="true">Click the page to use it</div>
      {/if}
    {/if}
  </div>
  </div>
  {#if turnRow && steps.total > 0}
    <ol class="cb-log" aria-label="Claude's last browser steps" start={steps.steps[0]?.n ?? 1}>
      {#each steps.steps as st (st.id)}
        <li class="cb-step" data-state={st.state}>
          <span class="st-n">step {st.n}</span>
          <b class="st-tool">{st.tool}</b>
          <span class="st-target"
            >{st.target ?? ""}{#if st.state === "running"}<span class="st-state">{st.target ? " · " : ""}running</span
              >{:else if st.state === "failed"}<span class="st-state">{st.target ? " · " : ""}failed</span>{/if}</span
          >
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .cb {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  /* Item 550 — Filament IV's browser bar (521 report, f4-browser.png):
     boxed controls, the address in mono on the field colour with its
     scheme dim, the hold strip under it in the signal colour. */
  .cb-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--line);
    background: var(--sheet);
    flex: none;
    min-width: 0;
  }
  .nb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid var(--line2);
    border-radius: var(--r1);
    background: var(--well);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    color: var(--ink2);
    cursor: pointer;
  }
  .nb:hover:not(:disabled) {
    background: var(--well2);
    border-color: var(--dim);
    color: var(--ink);
  }
  .nb:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .nb:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .wb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    min-width: 24px;
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
  .wb:hover {
    background: var(--well);
    color: var(--ink);
  }
  .addr-wrap {
    flex: 1;
    min-width: 80px;
    height: 32px;
    display: flex;
    align-items: center;
    padding: 0 10px;
    border: 1px solid var(--line2);
    border-radius: var(--r1);
    background: var(--term);
  }
  .addr-wrap.editing,
  .addr-wrap.draft {
    border-color: var(--dim);
  }
  .addr-wrap.bad {
    border-color: var(--failed);
  }
  .scheme {
    flex: none;
    color: var(--dim);
    font-size: 12.5px;
    margin-right: 1px;
    white-space: pre;
  }
  .addr {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ink);
    font-family: var(--mono);
    font-size: 12.5px;
    text-overflow: ellipsis;
    outline: none;
  }
  .addr:disabled {
    color: var(--dim);
  }
  .pages {
    flex: none;
    font-size: 11px;
    color: var(--dim);
  }
  .cb-hold {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 6px 14px;
    border-bottom: 1px solid var(--line);
    background: var(--signal-soft);
    font-size: 12.5px;
    color: var(--ink2);
  }
  .cb-hold[data-tone="you"] {
    background: var(--accent-soft);
  }
  .cb-hold[data-tone="idle"] {
    background: var(--sheet);
  }
  .hold-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--signal);
  }
  .cb-hold[data-tone="you"] .hold-dot {
    background: var(--accent);
  }
  .cb-hold[data-tone="idle"] .hold-dot {
    background: transparent;
    border: 1px solid var(--dim);
  }
  .hold-who {
    flex: none;
    font-weight: 600;
    color: var(--signal-ink);
  }
  .cb-hold[data-tone="you"] .hold-who {
    color: var(--accent-ink);
  }
  .cb-hold[data-tone="idle"] .hold-who {
    color: var(--ink2);
  }
  .hold-detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .cb-stage {
    flex: 1;
    min-height: 0;
    display: flex;
    padding: 14px 16px 16px;
    background: var(--paper);
  }
  .cb-pic {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-radius: var(--r1);
    background: var(--term);
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
  .frame {
    border-radius: var(--r1);
    box-shadow: 0 0 0 1px var(--line2);
  }
  .cb-pic.armed .frame {
    box-shadow: 0 0 0 2px var(--signal);
  }
  .arm-hint {
    position: absolute;
    right: 10px;
    bottom: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.62);
    color: #e6e9ee;
    font-size: 11px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms;
  }
  .cb-pic:hover .arm-hint {
    opacity: 1;
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
  /* Item 567: Stop Claude and the step log (both layouts). */
  .stop-sq {
    width: 8px;
    height: 8px;
    border-radius: 1.5px;
    background: currentColor;
    flex: none;
  }
  .cb-log {
    flex: none;
    margin: 0;
    padding: 6px 14px;
    list-style: none;
    border-top: 1px solid var(--line);
    background: var(--sheet);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
  .cb-step {
    display: grid;
    grid-template-columns: 64px 80px minmax(0, 1fr);
    gap: 10px;
    padding: 2px 0;
  }
  .st-tool {
    font-weight: 400;
    color: var(--ink2);
  }
  .st-target {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cb-step[data-state="running"] .st-tool,
  .cb-step[data-state="running"] .st-target {
    color: var(--signal, var(--live));
  }
  .cb-step[data-state="failed"] .st-state {
    color: var(--failed);
  }
</style>
