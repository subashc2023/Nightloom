<script lang="ts">
  /**
   * The phone page (nightshift backlog 091, Shape B): the open project's
   * chats, a chat's transcript with the live turn folded from the event
   * stream, Send, Stop, the three cards, and a queue for messages typed
   * while the Mac is unreachable. Served by the listener in the desktop
   * process at the Mac's tailnet address; added to the home screen.
   *
   * First screen (blocker 174's default): the chat list, the open chat
   * marked, so a glance says what the Mac is on before a tap.
   */
  import { onMount } from "svelte";
  import {
    ApiError,
    Client,
    KEEP_PLANNING,
    Unreachable,
    backoffMs,
    cardKind,
    emptyTurn,
    foldTurnEvent,
    loadQueue,
    loadToken,
    newQueued,
    questionAnswer,
    saveQueue,
    saveToken,
    tokenFromHash,
    transcriptRows,
    type ChatRow,
    type LiveTurn,
    type Queued,
    type RemoteState,
    type ToolRow,
  } from "./client";
  import { renderMarkdown } from "../lib/markdown";
  import { arrive, launch } from "../lib/sendMotion";
  import type { ApprovalRequest, AskQuestion, SessionEvent, TurnEvent } from "../lib/types";

  // ---- the token and the connection --------------------------------------
  let token = $state<string | null>(null);
  let box = $state<HTMLTextAreaElement | null>(null);
  let paste = $state("");
  let client = $state<Client | null>(null);
  /** `online` while the event stream is open; `off` after the listener
   *  answered 401 (the token is wrong — a new scan is the way back). */
  let link = $state<"connecting" | "online" | "offline" | "off">("connecting");
  let failures = 0;
  let abort: AbortController | null = null;

  // ---- what the Mac says ---------------------------------------------------
  let remote = $state<RemoteState>({ project: null, active_chat: null, busy: false, connected: false, engine: null, pending: [] });
  let chats = $state<ChatRow[]>([]);
  let screen = $state<"chats" | "chat">("chats");
  let chatId = $state<string | null>(null);
  let events = $state<SessionEvent[]>([]);
  let live = $state<LiveTurn | null>(null);
  let toast = $state<string | null>(null);
  let error = $state<string | null>(null);
  let draft = $state("");
  let queue = $state<Queued[]>(loadQueue());
  let scroller = $state<HTMLElement | null>(null);

  const rows = $derived(transcriptRows(events));
  const chatLabel = $derived(chats.find((c) => c.id === chatId)?.label ?? (chatId ? chatId.slice(0, 8) : "chat"));
  /** The live turn belongs to the desktop's open chat; another chat's
   *  view shows nothing live and re-reads when the turn ends. */
  const liveHere = $derived(live !== null && chatId !== null && chatId === remote.active_chat);
  const pendingHere = $derived(chatId !== null && chatId === remote.active_chat ? remote.pending : []);

  function note(text: string) {
    toast = text;
    setTimeout(() => {
      if (toast === text) toast = null;
    }, 4000);
  }

  /** A wrong token ends the link; an unreachable Mac marks it offline; any
   *  other failure shows its sentence — unless `quiet`, for the background
   *  reads, whose failure the offline bar already says. */
  function fail(e: unknown, quiet = false) {
    if (e instanceof ApiError && e.status === 401) {
      link = "off";
      error = e.message;
      return;
    }
    if (e instanceof Unreachable) {
      if (link !== "off") link = "offline";
      return;
    }
    if (!quiet) error = String(e instanceof Error ? e.message : e);
  }

  async function refreshState() {
    if (!client) return;
    try {
      const was = remote.busy;
      remote = await client.state();
      if (was && !remote.busy) await turnEnded();
    } catch (e) {
      fail(e, true);
    }
  }

  async function refreshChats() {
    if (!client) return;
    try {
      chats = await client.chats();
    } catch (e) {
      fail(e, true);
    }
  }

  async function refreshTranscript() {
    if (!client || !chatId) return;
    try {
      events = await client.transcript(chatId);
      scrollToEnd();
    } catch (e) {
      fail(e, true);
    }
  }

  /** The turn is over: the log on disk is whole, the live fold can go, and
   *  anything held in the queue can leave. */
  async function turnEnded() {
    live = null;
    await refreshTranscript();
    await refreshChats();
    await drainQueue();
  }

  async function everything() {
    await refreshState();
    await refreshChats();
    if (chatId) await refreshTranscript();
    await drainQueue();
  }

  // ---- the event stream -----------------------------------------------------
  function onEvent(name: string, data: string) {
    switch (name) {
      case "hello":
        link = "online";
        failures = 0;
        void everything();
        break;
      case "turn-event": {
        let ev: TurnEvent;
        try {
          ev = JSON.parse(data);
        } catch {
          return;
        }
        // A turn is running: mark it before the next state poll does.
        if (!remote.busy) remote = { ...remote, busy: true };
        live = foldTurnEvent(live ?? emptyTurn(), ev);
        scrollToEnd();
        break;
      }
      case "tool-approval": {
        try {
          const req: ApprovalRequest = JSON.parse(data);
          if (!remote.pending.some((p) => p.id === req.id)) remote = { ...remote, pending: [...remote.pending, req] };
        } catch {
          // A payload the phone cannot read is one it cannot answer.
        }
        break;
      }
      case "turn-notice":
        try {
          note(JSON.parse(data));
        } catch {
          note(data);
        }
        break;
      case "lagged":
        void everything();
        break;
      default:
        break;
    }
  }

  // A function, not the variable: `fail` sets `link` from under the loop,
  // and a direct read after the assignment is narrowed past that.
  const tokenRefused = () => link === "off";

  async function streamLoop() {
    for (;;) {
      if (!client || tokenRefused()) return;
      abort = new AbortController();
      link = failures === 0 ? "connecting" : "offline";
      try {
        await client.events(onEvent, abort.signal);
        // The stream ended cleanly: the listener went off. Try again.
      } catch (e) {
        fail(e, true);
      }
      if (tokenRefused()) return;
      failures += 1;
      link = "offline";
      await new Promise((r) => setTimeout(r, backoffMs(failures)));
    }
  }

  /** While a turn runs the stream carries no "done": the state is polled
   *  every three seconds and the flip of `busy` is the end. */
  function pollLoop() {
    setInterval(() => {
      if (link === "online" && (remote.busy || live !== null || queue.length > 0)) void refreshState();
    }, 3000);
  }

  function start(t: string) {
    token = t;
    saveToken(t);
    client = new Client(t);
    error = null;
    failures = 0;
    void streamLoop();
  }

  function forget() {
    abort?.abort();
    token = null;
    client = null;
    saveToken(null);
    link = "connecting";
    error = null;
  }

  onMount(() => {
    const fromHash = tokenFromHash(location.hash);
    if (fromHash) {
      // Off the address bar the moment it is read: a token in the history
      // is a token in a screenshot.
      history.replaceState(null, "", location.pathname + location.search);
      start(fromHash);
    } else {
      const stored = loadToken();
      if (stored) start(stored);
    }
    pollLoop();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && client && link !== "off") void everything();
    });
  });

  // ---- the screens ----------------------------------------------------------
  async function openChat(id: string) {
    chatId = id;
    screen = "chat";
    events = [];
    await refreshTranscript();
  }

  function back() {
    screen = "chats";
    chatId = null;
    void refreshChats();
  }

  function scrollToEnd() {
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }

  // ---- send, the queue, stop ------------------------------------------------
  async function sendNow() {
    const text = draft.trim();
    if (!text) return;
    draft = "";
    if (link !== "online" || remote.busy) {
      hold(text);
      return;
    }
    try {
      const status = await client!.send(chatId, text);
      remote = { ...remote, busy: true };
      if (status === "queued") {
        // The Mac has it behind the running turn (backlog 132): it lands
        // in the transcript when its own turn runs, so nothing is drawn
        // yet — a row drawn now would vanish on the re-read.
        note("the Mac is mid-turn — your message goes when it ends");
        return;
      }
      live = emptyTurn();
      // It flies up from the box (backlog 194); the box's words are gone
      // already, but it has not moved.
      launch("phone", box);
      // Drawn at once rather than after the log's re-read: his message is
      // the one thing on the page he already knows the text of.
      events = [...events, { event: "user_message", text, at: new Date().toISOString() }];
      scrollToEnd();
    } catch (e) {
      if (e instanceof Unreachable) hold(text);
      else {
        // A refusal (409, 401, a 5xx) is not a hold: the text goes back
        // into the composer rather than nowhere, so nothing typed is lost.
        fail(e);
        if (!draft) draft = text;
      }
    }
  }

  function hold(text: string) {
    queue = [...queue, newQueued(chatId, text)];
    saveQueue(queue);
    note(link === "online" ? "held — goes when the turn ends" : "held — goes when the Mac is reachable");
  }

  function takeBack(id: string) {
    const q = queue.find((m) => m.id === id);
    queue = queue.filter((m) => m.id !== id);
    saveQueue(queue);
    if (q && !draft) draft = q.text;
  }

  /** The oldest held message goes when the Mac is reachable and idle; the
   *  next waits for that turn's end. */
  async function drainQueue() {
    if (!client || link !== "online" || remote.busy || queue.length === 0) return;
    const [next, ...rest] = queue;
    try {
      const status = await client.send(next.chat, next.text);
      queue = rest;
      saveQueue(queue);
      remote = { ...remote, busy: true };
      if (status === "queued") {
        note("the Mac is mid-turn — the held message goes when it ends");
        return;
      }
      if (next.chat === chatId) {
        live = emptyTurn();
        events = [...events, { event: "user_message", text: next.text, at: new Date().toISOString() }];
        scrollToEnd();
      }
    } catch (e) {
      fail(e);
    }
  }

  async function stop() {
    if (!client) return;
    try {
      // The chat this page shows (backlog 159, A3), not the Mac's screen.
      await client.cancel(chatId);
      remote = { ...remote, pending: [] };
    } catch (e) {
      fail(e);
    }
  }

  // ---- the cards --------------------------------------------------------------
  let notes = $state<Record<string, string>>({});
  let picks = $state<Record<string, Record<number, string[]>>>({});
  let others = $state<Record<string, Record<number, string>>>({});
  let planThen = $state<Record<string, "ask" | "auto">>({});

  async function answer(
    req: ApprovalRequest,
    decision: "allow" | "always" | "deny",
    answerPayload?: unknown,
    then?: "ask" | "auto",
    fallback?: string,
  ) {
    if (!client) return;
    const text = (notes[req.id] ?? "").trim();
    // The note rides as the deny reason; with an accepting button it is
    // the next message, as the desktop's card does it (`routeNote`).
    const reason = decision === "deny" ? text || fallback : undefined;
    remote = { ...remote, pending: remote.pending.filter((p) => p.id !== req.id) };
    try {
      await client.approve({ id: req.id, name: req.name, decision, reason, answer: answerPayload, then });
      if (decision !== "deny" && text) hold(text);
    } catch (e) {
      fail(e);
    }
  }

  function questions(req: ApprovalRequest): AskQuestion[] {
    const q = (req.input as { questions?: unknown } | null)?.questions;
    return Array.isArray(q) ? (q as AskQuestion[]) : [];
  }

  function toggle(id: string, i: number, label: string, multi: boolean) {
    const mine = picks[id] ?? {};
    const cur = mine[i] ?? [];
    mine[i] = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
    picks = { ...picks, [id]: mine };
  }

  function answered(req: ApprovalRequest): boolean {
    const qs = questions(req);
    return qs.length > 0 && qs.every((_, i) => (picks[req.id]?.[i]?.length ?? 0) > 0 || (others[req.id]?.[i] ?? "").trim() !== "");
  }

  function planOf(req: ApprovalRequest): string | null {
    const p = (req.input as { plan?: unknown } | null)?.plan;
    return typeof p === "string" ? p : null;
  }

  function fields(input: unknown): { key: string; value: string }[] {
    if (input === null || typeof input !== "object") return [];
    return Object.entries(input as Record<string, unknown>).map(([key, v]) => ({
      key,
      value: typeof v === "string" ? v : JSON.stringify(v, null, 1),
    }));
  }

  function when(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
</script>

{#snippet toolRows(tools: ToolRow[], depth: number)}
  {#each tools as t (t.id)}
    <div class="tool" style:padding-left="{depth * 14}px">
      <span class="tool-dot" class:ok={t.ok === true} class:bad={t.ok === false} class:run={t.ok === null}></span>
      <span class="tool-name">{t.name}</span>
      <span class="tool-sum">{t.summary}</span>
    </div>
    {#if t.children.length > 0}{@render toolRows(t.children, depth + 1)}{/if}
  {/each}
{/snippet}

<div class="page">
  {#if !token}
    <div class="gate">
      <h1>Nightloom</h1>
      <p>Open the link from Settings → Remote on the Mac (scan its QR with the camera), or paste the token here.</p>
      <input type="text" placeholder="token" bind:value={paste} autocapitalize="off" autocomplete="off" spellcheck="false" />
      <button class="btn accent" disabled={!/^[0-9a-fA-F]{16,128}$/.test(paste.trim())} onclick={() => start(paste.trim().toLowerCase())}>
        Connect
      </button>
    </div>
  {:else}
    <header class="top">
      {#if screen === "chat"}
        <button class="btn ghost" onclick={back} aria-label="Back to chats">‹ Chats</button>
      {:else}
        <span class="title">{remote.project ?? "Unfiled"}</span>
      {/if}
      <span class="spacer"></span>
      <span class="link" class:online={link === "online"} class:off={link === "off"} title={link}>
        {link === "online" ? (remote.busy ? "running" : remote.connected ? "idle" : "no engine") : link}
      </span>
    </header>

    {#if link === "off"}
      <div class="bar bad">
        {error ?? "the token is wrong"} —
        <button class="btn link" onclick={forget}>scan again</button>
      </div>
    {:else if link !== "online"}
      <div class="bar">Mac unreachable — is Tailscale on, and Remote switched on in Settings? Messages you send are held.</div>
    {/if}
    {#if error && link !== "off"}
      <div class="bar bad">{error} <button class="btn link" onclick={() => (error = null)}>×</button></div>
    {/if}

    {#if screen === "chats"}
      <main class="list">
        {#each chats as c (c.id)}
          <button class="row" class:open={c.id === remote.active_chat} onclick={() => openChat(c.id)}>
            <span class="row-label">{c.label}</span>
            <span class="row-meta">
              {#if c.id === remote.active_chat}<b>open{remote.busy ? " · running" : ""}</b> · {/if}{c.kind}{c.mode !== "normal" ? ` · ${c.mode}` : ""} · {c.user_turns} · {when(c.modified)}
            </span>
          </button>
        {:else}
          <p class="empty">{link === "online" ? "No chats in this project yet." : "Waiting for the Mac…"}</p>
        {/each}
        {#if remote.active_chat === null && link === "online"}
          <p class="empty small">The Mac has no chat open; a message sent from the list starts one.</p>
        {/if}
      </main>
    {:else}
      <main class="chat" bind:this={scroller}>
        <div class="chat-title">{chatLabel}</div>
        {#each rows as r, i (i)}
          {#if r.kind === "user"}
            <div class="msg user" use:arrive={{ channel: "phone" }}>{r.text}</div>
          {:else if r.kind === "assistant"}
            <div class="msg reply">
              {#if r.tools.length > 0}<div class="tools">{@render toolRows(r.tools, 0)}</div>{/if}
              {#if r.text}<div class="md">{@html renderMarkdown(r.text)}</div>{/if}
            </div>
          {:else}
            <div class="msg note">{r.text}</div>
          {/if}
        {/each}
        {#if liveHere && live}
          <div class="msg reply live">
            {#if live.tools.length > 0}<div class="tools">{@render toolRows(live.tools, 0)}</div>{/if}
            {#if live.text}<div class="md">{@html renderMarkdown(live.text)}</div>{/if}
            {#if !live.text && live.tools.length === 0}<span class="thinking">…</span>{/if}
          </div>
        {:else if remote.busy && chatId === remote.active_chat}
          <div class="msg note">a turn is running on the Mac</div>
        {/if}

        {#each pendingHere as req (req.id)}
          {@const kind = cardKind(req)}
          <section class="card">
            {#if kind === "question"}
              <div class="card-head">The model asks</div>
              {#each questions(req) as q, i (i)}
                <div class="q">
                  <div class="q-text">{q.header ? `${q.header} — ` : ""}{q.question}</div>
                  <div class="opts">
                    {#each q.options as o (o.label)}
                      <button
                        class="opt"
                        class:on={(picks[req.id]?.[i] ?? []).includes(o.label)}
                        onclick={() => toggle(req.id, i, o.label, !!q.multiSelect)}
                      >
                        <b>{o.label}</b>{#if o.description}<span>{o.description}</span>{/if}
                      </button>
                    {/each}
                  </div>
                  <input
                    type="text"
                    placeholder="other…"
                    value={others[req.id]?.[i] ?? ""}
                    oninput={(e) => (others = { ...others, [req.id]: { ...(others[req.id] ?? {}), [i]: e.currentTarget.value } })}
                  />
                </div>
              {/each}
              <input type="text" class="note-field" placeholder="a note (goes as your next message)" bind:value={notes[req.id]} />
              <div class="actions">
                <button class="btn accent" disabled={!answered(req)} onclick={() => answer(req, "allow", questionAnswer(req.input, picks[req.id] ?? {}, others[req.id] ?? {}))}>Answer</button>
                <button class="btn" onclick={() => answer(req, "deny", undefined, undefined, "the user skipped the question")}>Skip</button>
              </div>
            {:else if kind === "plan"}
              <div class="card-head">The plan</div>
              {#if planOf(req)}<div class="md plan">{@html renderMarkdown(planOf(req)!)}</div>{/if}
              <input type="text" class="note-field" placeholder="a note (why, or what to change)" bind:value={notes[req.id]} />
              <div class="then">
                after approval:
                <button class="opt small" class:on={(planThen[req.id] ?? "ask") === "ask"} onclick={() => (planThen = { ...planThen, [req.id]: "ask" })}>ask</button>
                <button class="opt small" class:on={planThen[req.id] === "auto"} onclick={() => (planThen = { ...planThen, [req.id]: "auto" })}>auto</button>
              </div>
              <div class="actions">
                <button class="btn accent" onclick={() => answer(req, "allow", req.input, planThen[req.id] ?? "ask")}>Approve</button>
                <button class="btn" onclick={() => answer(req, "deny", undefined, undefined, KEEP_PLANNING)}>Keep planning</button>
              </div>
            {:else}
              <div class="card-head">Allow <b>{req.name}</b>?</div>
              <div class="args">
                {#each fields(req.input) as f (f.key)}
                  <div class="arg"><span class="key">{f.key}</span><pre>{f.value}</pre></div>
                {/each}
              </div>
              <input type="text" class="note-field" placeholder="a note (the reason, if denied)" bind:value={notes[req.id]} />
              <div class="actions">
                <button class="btn accent" onclick={() => answer(req, "allow")}>Allow</button>
                <button class="btn" onclick={() => answer(req, "always")}>Allow for this chat</button>
                <button class="btn danger" onclick={() => answer(req, "deny")}>Deny</button>
              </div>
            {/if}
          </section>
        {/each}
      </main>
    {/if}

    {#if queue.length > 0}
      <div class="queue">
        {#each queue as q (q.id)}
          <div class="held">
            <span class="held-text">{q.text}</span>
            <span class="held-meta">{q.chat && q.chat !== chatId ? "another chat · " : ""}held</span>
            <button class="btn link" onclick={() => takeBack(q.id)} aria-label="Take back">×</button>
          </div>
        {/each}
      </div>
    {/if}

    <footer class="composer">
      <textarea
        bind:this={box}
        rows="1"
        placeholder={screen === "chat" ? "Message" : remote.active_chat ? "Message the open chat" : "Message (starts a chat)"}
        bind:value={draft}
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void sendNow();
          }
        }}
      ></textarea>
      {#if remote.busy && link === "online"}
        <button class="btn danger" onclick={stop} aria-label="Stop the turn">Stop</button>
      {/if}
      <button class="btn accent" disabled={!draft.trim()} onclick={sendNow}>{link === "online" && !remote.busy ? "Send" : "Hold"}</button>
    </footer>

    {#if toast}<div class="toast">{toast}</div>{/if}
  {/if}
</div>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #111214;
    color: #e6e6e3;
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
    -webkit-text-size-adjust: 100%;
    overscroll-behavior: none;
    /* The page never scrolls sideways (his report, 2026-09-18: "on the
       phone version you're able to scroll sideways"): anything wider than
       the screen — a long URL, a code block, a table — scrolls inside its
       own box below, and the body clips the rest. */
    width: 100%;
    overflow-x: hidden;
  }
  .page {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    width: 100%;
    overflow-x: hidden;
    padding-top: env(safe-area-inset-top, 0px);
    box-sizing: border-box;
  }
  .gate {
    padding: 48px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .gate h1 {
    font-size: 22px;
    margin: 0;
  }
  .gate p {
    color: #a3a39e;
    margin: 0;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid #26272b;
    min-height: 44px;
  }
  .title {
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .link {
    font-size: 12px;
    color: #a3a39e;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid #33353a;
  }
  .link.online {
    color: #9ad27f;
    border-color: #3d5a32;
  }
  .link.off {
    color: #e08a7a;
    border-color: #6a3a32;
  }
  .bar {
    padding: 8px 12px;
    font-size: 13px;
    background: #1c1d21;
    color: #d9c98c;
    border-bottom: 1px solid #26272b;
  }
  .bar.bad {
    color: #e08a7a;
  }
  main {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
  }
  .list {
    display: flex;
    flex-direction: column;
  }
  .row {
    all: unset;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 14px;
    border-bottom: 1px solid #202126;
    cursor: pointer;
  }
  .row.open {
    background: #1a1c22;
    box-shadow: inset 3px 0 0 #7aa2f7;
  }
  .row-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    font-size: 12px;
    color: #8a8a86;
  }
  .row-meta b {
    color: #7aa2f7;
    font-weight: 600;
  }
  .empty {
    color: #8a8a86;
    padding: 24px 16px;
    text-align: center;
  }
  .empty.small {
    font-size: 12px;
    padding-top: 0;
  }
  .chat {
    padding: 8px 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .chat-title {
    font-size: 12px;
    color: #8a8a86;
    text-align: center;
    padding: 4px 0 8px;
  }
  .msg {
    max-width: 100%;
    /* A flex item's default `min-width: auto` lets a wide child (a code
       block) push the column past the screen; zero lets it shrink. */
    min-width: 0;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  .msg.user {
    align-self: flex-end;
    background: #2a2d36;
    border-radius: 18px;
    padding: 8px 14px;
    max-width: 85%;
    white-space: pre-wrap;
  }
  .msg.reply {
    align-self: stretch;
  }
  .msg.reply.live {
    opacity: 0.95;
  }
  .msg.note {
    align-self: center;
    font-size: 12px;
    color: #8a8a86;
    font-style: italic;
  }
  .thinking {
    color: #8a8a86;
  }
  .tools {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 6px;
    font-size: 12px;
    color: #a3a39e;
  }
  .tool {
    display: flex;
    gap: 6px;
    align-items: baseline;
    white-space: nowrap;
    overflow: hidden;
  }
  .tool-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #55575d;
    flex: none;
    align-self: center;
  }
  .tool-dot.ok {
    background: #9ad27f;
  }
  .tool-dot.bad {
    background: #e08a7a;
  }
  .tool-dot.run {
    background: #7aa2f7;
    animation: pulse 1.2s infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  .tool-name {
    font-weight: 600;
    flex: none;
  }
  .tool-sum {
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
  }
  .md :global(p) {
    margin: 0 0 0.6em;
  }
  .md :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }
  .md :global(img) {
    max-width: 100%;
    height: auto;
  }
  .md :global(pre) {
    overflow-x: auto;
    max-width: 100%;
    background: #1a1b1f;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 12px;
  }
  .md :global(code) {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.92em;
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.2em;
  }
  .card {
    border: 1px solid #3a3d47;
    border-radius: 12px;
    padding: 12px;
    background: #17181c;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .card-head {
    font-weight: 600;
  }
  .args {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 40dvh;
    overflow: auto;
  }
  .arg .key {
    font-size: 11px;
    color: #8a8a86;
  }
  .arg pre {
    margin: 2px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 12px;
    background: #1f2025;
    padding: 6px 8px;
    border-radius: 6px;
  }
  .plan {
    max-height: 55dvh;
    overflow: auto;
    font-size: 14px;
  }
  .q {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .q-text {
    font-size: 14px;
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .opt {
    all: unset;
    display: flex;
    flex-direction: column;
    padding: 8px 10px;
    border: 1px solid #33353a;
    border-radius: 8px;
    font-size: 14px;
    cursor: pointer;
  }
  .opt span {
    font-size: 12px;
    color: #8a8a86;
  }
  .opt.on {
    border-color: #7aa2f7;
    background: #1e2430;
  }
  .opt.small {
    display: inline-flex;
    padding: 2px 10px;
    font-size: 12px;
    margin-left: 4px;
  }
  .then {
    font-size: 12px;
    color: #8a8a86;
  }
  input[type="text"],
  textarea {
    width: 100%;
    box-sizing: border-box;
    background: #1f2025;
    color: inherit;
    border: 1px solid #33353a;
    border-radius: 8px;
    padding: 8px 10px;
    font: inherit;
    font-size: 16px; /* under 16px iOS Safari zooms the page on focus */
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .btn {
    all: unset;
    cursor: pointer;
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #33353a;
    font-size: 14px;
    text-align: center;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .btn.accent {
    background: #7aa2f7;
    color: #0e1016;
    border-color: #7aa2f7;
    font-weight: 600;
  }
  .btn.danger {
    color: #e08a7a;
    border-color: #6a3a32;
  }
  .btn.ghost {
    border: none;
    padding: 4px 2px;
    color: #7aa2f7;
  }
  .btn.link {
    border: none;
    padding: 0 4px;
    color: #7aa2f7;
    font-size: inherit;
  }
  .queue {
    border-top: 1px solid #26272b;
    background: #15161a;
    max-height: 30dvh;
    overflow: auto;
  }
  .held {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    font-size: 13px;
  }
  .held-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .held-meta {
    font-size: 11px;
    color: #8a8a86;
  }
  .composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid #26272b;
    background: #111214;
  }
  .composer textarea {
    flex: 1;
    resize: none;
    max-height: 30dvh;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(80px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    background: #2a2d36;
    padding: 8px 14px;
    border-radius: 999px;
    font-size: 13px;
    max-width: 90vw;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
</style>
