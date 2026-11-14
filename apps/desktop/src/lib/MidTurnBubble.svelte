<script lang="ts">
  import { onDestroy } from "svelte";
  import UserBubble from "./UserBubble.svelte";
  // Item 542: under the Classic layout, 1d4ca17's bubble.
  import UserBubbleClassic from "./UserBubbleClassic.svelte";
  import { classic } from "./layout.svelte";
  const Bubble = $derived(classic() ? UserBubbleClassic : UserBubble);
  import { tip } from "./tip";
  import type { Attachment } from "./types";
  import WaitAct from "./WaitAct.svelte";
  import FoldText from "./FoldText.svelte";
  import { fly, launchAt, reducedMotion, takeLaunch } from "./sendMotion";
  import { handoff } from "./handoff.svelte";
  import { app } from "./state.svelte";
  import { readDraft } from "./drafts.svelte";
  import {
    bubblePlan,
    flightLeft,
    flying,
    heldTip,
    pendingHead,
    sendHeld,
    takeMidLanding,
    trackFlight,
    type HeldWhy,
    cancelPending,
    editPending,
    letArrive,
    offersChoice,
    offersReply,
    offersSendNow,
    pendingLabel,
    pendingState,
    sendAsReply,
    sendNow,
    sendNowTip,
  } from "./pendingBubble.svelte";
  import type { QueuedMessage } from "./drafts.svelte";

  /**
   * His message sent while a turn runs (nightshift item 465), drawn as his
   * bubble: `row` (still queued) greyed with its pending mark and choices,
   * or `delivered` (the turn took it) as an ordinary bubble in the reply.
   * Its own component so the transcript renderer only places it.
   */
  let {
    row = null,
    chatKey = "",
    delivered = null,
    waiting = false,
    held = null,
    aside = null,
  }: {
    row?: QueuedMessage | null;
    chatKey?: string;
    delivered?: { text: string; after: string } | null;
    /** Item 522: a prompt waits on him in this chat — no process runs. */
    waiting?: boolean;
    /** Item 548 (Filament IV): no turn runs and the row waits — why. */
    held?: HeldWhy | null;
    /** Item 674's follow-up: a row of an aside's queue — it goes when the
     *  aside's answer ends; nothing reaches a running answer, so no Send
     *  now / Let it arrive, only Edit and Cancel. */
    aside?: { busy: boolean; blocked: "engine" | "not-open" | null } | null;
  } = $props();
  /** An aside row's state line and its tip (the aside box's own words). */
  const asideHead = $derived(
    !aside
      ? null
      : aside.busy
        ? { line: "queued · sent when this answer ends", tip: "Not sent yet — it goes as the next question when this answer ends" }
        : aside.blocked === "not-open"
          ? { line: "queued · waiting — open the chat to send", tip: "Not sent yet — an aside answers from its chat's context; open the chat and it goes" }
          : aside.blocked === "engine"
            ? { line: "queued · waiting — connect Claude Code", tip: "Not sent yet — an aside is answered by Claude Code" }
            : { line: "queued · waiting to send", tip: "Not sent yet" },
  );

  /** Items 548/549/547: the Filament IV look; Classic keeps 465's words. */
  const filament = $derived(!classic());
  /** The wrap-up Nightloom queued while he was away (item 548: its tag, as the tray row had). */
  const wrapUp = $derived(!!row && handoff.queuedId === row.id && handoff.chat !== null && handoff.chat === app.activeSessionId);

  const pending = $derived(row !== null);
  const st = $derived(row ? pendingState(row, waiting) : null);
  const arrive = $derived(row ? letArrive[row.id] === true : false);
  /** Item 536: what *Send now* does for this row, and why it is not handed in. */
  const plan = $derived(row && st ? bubblePlan(chatKey, row.id) : null);
  let confirming = $state(false);
  let working = $state(false);

  const images = $derived((row?.attachments ?? []).filter((a: Attachment) => a.kind === "image" && a.data).map((a) => ({ media_type: a.media_type, data: a.data! })));
  const documents = $derived(
    (row?.attachments ?? []).filter((a: Attachment) => a.kind === "document" && a.data).map((a) => ({ media_type: a.media_type, name: a.name, data: a.data! })),
  );

  /** Item 515: a file for Claude Code it carries, as a card by name. */
  const sending = $derived((row?.attachments ?? []).filter((a: Attachment) => a.kind === "file").map((a) => a.name));
  /**
   * Item 547: once *Send now* is pressed, the bubble's place is kept each
   * frame; when it leaves (the turn took it, or the stopped turn's next
   * message is it), that place is where the delivered bubble flies from.
   */
  let bubbleEl = $state<HTMLElement | null>(null);
  $effect(() => {
    if (!row || !filament) return;
    const qid = row.id;
    const text = row.text;
    const key = chatKey;
    if (!flying[qid]) return;
    let raf = 0;
    const loop = () => {
      const el = bubbleEl?.querySelector(".user-bubble") ?? bubbleEl;
      if (el?.isConnected) trackFlight(qid, text, el);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      // Read once the redraw has settled: a teardown can be this effect
      // re-running (the bubble stays and goes on tracking) or the bubble
      // leaving, and the row's removal may land in the same redraw.
      setTimeout(() => {
        const still = readDraft(key).queue.some((r) => r.id === qid && r.inject?.after === undefined);
        if (still && alive) return;
        flightLeft(qid, still, launchAt);
      }, 0);
    };
  });
  let alive = true;
  onDestroy(() => {
    alive = false;
  });
  function lift(): void {
    if (row && filament && !reducedMotion()) flying[row.id] = true;
  }

  /**
   * Item 547, the landing: a delivered bubble (the turn took his message)
   * that is the one he pressed *Send now* on flies in from its waiting
   * place — backlog 194's ghost and thread, `sendMotion.fly`. Watched for
   * a few frames, since the waiting bubble and this one change in the same
   * redraw in either order. Reduced motion: nothing moves.
   */
  function landMid(node: HTMLElement, text: string) {
    let raf = 0;
    let tries = 0;
    let cancel: (() => void) | null = null;
    const look = () => {
      raf = 0;
      if (reducedMotion()) return;
      const m = takeMidLanding(text);
      if (m) {
        takeLaunch("chat");
        const bubble = node.querySelector<HTMLElement>(".user-bubble") ?? node;
        const w = window as unknown as { __sendMotionHold?: number };
        cancel = fly(node, bubble, { channel: "midturn", at: m.at, x: m.x, y: m.y, w: m.w, h: m.h }, typeof w.__sendMotionHold === "number" ? w.__sendMotionHold : null);
        return;
      }
      if (++tries < 12) raf = requestAnimationFrame(look);
    };
    raf = requestAnimationFrame(look);
    return {
      destroy() {
        if (raf) cancelAnimationFrame(raf);
        cancel?.();
      },
    };
  }

  async function run(f: () => Promise<unknown>): Promise<void> {
    if (working) return;
    working = true;
    try {
      await f();
    } finally {
      working = false;
    }
  }
</script>

{#if filament}
<!-- Items 548 + 549 + 547 (Filament IV): a short state line (the long one
     is its tip), the words folded past six lines with "more", the actions
     as icons, and Send now flies the message into the turn. -->
<div
  class="midturn fil"
  class:pending
  data-midturn={pending ? "pending" : "delivered"}
  data-queue-id={row?.id}
  data-hand={plan?.why ?? undefined}
  data-held={held ?? undefined}
>
  <div class="mt-key">
    {#if pending && st}
      <span class="mt-mark" class:still={!!held} aria-hidden="true"></span>
      {#if asideHead}
        <span class="mt-state" data-state={held ? `held-${held}` : st} data-aside use:tip={asideHead.tip}>{asideHead.line}</span>
      {:else}
        <span class="mt-state" data-state={held ? `held-${held}` : st} use:tip={held ? heldTip(held) : pendingLabel(st, arrive)}>{pendingHead(st, arrive, held)}</span>
      {/if}
      {#if wrapUp}
        <span class="ns-chip mono" data-wrapup use:tip={"Put here by Nightloom: the window crossed this chat's hand-off mark while you were away. Cancel takes it back."}
          >wrap-up · queued while you were away</span
        >
      {/if}
    {:else if delivered}
      <span class="mt-state" use:tip={`The running turn took it ${delivered.after}.`}>sent mid-reply · {delivered.after}</span>
    {/if}
    <span class="ns-k">You</span>
  </div>
  {#if pending && row}
    <div class="mt-bubble" bind:this={bubbleEl}>
      <FoldText foldKey={`q:${row.id}`}>
        <Bubble text={row.text} {images} {documents} {sending} />
      </FoldText>
    </div>
  {:else}
    <div class="mt-bubble" use:landMid={delivered?.text ?? ""}>
      <Bubble text={delivered?.text ?? ""} {images} {documents} {sending} />
    </div>
  {/if}
  {#if pending && row && st}
    <div class="mt-actions" role="group" aria-label="this message is not sent yet">
      {#if confirming}
        <span class="mt-ask">Cancel this message? It is not sent; its words go to the box's history.</span>
        <button class="ns-btn small danger" disabled={working} onclick={() => void run(() => cancelPending(chatKey, row!.id))}>Cancel message</button>
        <button class="ns-btn ghost small" onclick={() => (confirming = false)}>Keep it</button>
      {:else}
        {#if held && !aside}
          <WaitAct
            icon="send"
            accent
            label="Send now"
            hint="send it as the next message"
            data-mt="send-held"
            disabled={working || !app.connection}
            onclick={() => {
              lift();
              void run(() => sendHeld(row!.id));
            }}
          />
        {/if}
        {#if !held && !aside && offersReply(st)}
          <WaitAct
            icon="send"
            accent
            label="Send now"
            hint="in place of an answer: Claude reads your message instead of waiting on the card above, and carries on from it"
            data-mt="send-reply"
            disabled={working}
            onclick={() => {
              lift();
              void run(() => sendAsReply(chatKey, row!.id));
            }}
          />
        {/if}
        {#if !held && !aside && plan && offersSendNow(st, plan.plan)}
          <WaitAct
            icon="send"
            accent
            label="Send now"
            hint={sendNowTip(plan.plan, plan.why)}
            data-mt="send-now"
            data-plan={plan.plan}
            disabled={working}
            onclick={() => {
              lift();
              void run(() => sendNow(chatKey, row!.id));
            }}
          />
        {/if}
        {#if !held && !aside && offersChoice(st, arrive)}
          <WaitAct
            icon="check"
            label="Let it arrive"
            hint="leave it: Claude reads it at its next step, as it would anyway"
            data-mt="arrive"
            onclick={() => (letArrive[row!.id] = true)}
          />
        {/if}
        {#if st !== "replying"}
          <WaitAct icon="pencil" label="Edit" hint="take it back into the message box to change it" data-mt="edit" disabled={working} onclick={() => void run(() => editPending(chatKey, row!.id))} />
          <WaitAct icon="x" label="Cancel" hint="do not send it (asks first)" data-mt="cancel" disabled={working} onclick={() => (confirming = true)} />
        {/if}
      {/if}
    </div>
  {/if}
</div>
{:else}
<div class="midturn" class:pending data-midturn={pending ? "pending" : "delivered"} data-queue-id={row?.id} data-hand={plan?.why ?? undefined}>
  <div class="mt-key">
    {#if pending && st}
      <span class="mt-mark" aria-hidden="true"></span>
      <span class="mt-state" data-state={st}>{pendingLabel(st, arrive)}</span>
    {:else if delivered}
      <span class="mt-state" use:tip={`The running turn took it ${delivered.after}.`}>sent mid-reply · {delivered.after}</span>
    {/if}
    <span class="ns-k">You</span>
  </div>
  <div class="mt-bubble">
    <Bubble text={row?.text ?? delivered?.text ?? ""} {images} {documents} {sending} />
  </div>
  {#if pending && row && st}
    <div class="mt-actions" role="group" aria-label="this message is not sent yet">
      {#if confirming}
        <span class="mt-ask">Cancel this message? It is not sent; its words go to the box's history.</span>
        <button class="ns-btn small danger" disabled={working} onclick={() => void run(() => cancelPending(chatKey, row!.id))}>Cancel message</button>
        <button class="ns-btn ghost small" onclick={() => (confirming = false)}>Keep it</button>
      {:else}
        {#if offersReply(st)}
          <button
            class="ns-btn small"
            data-mt="send-reply"
            disabled={working}
            use:tip={"Send this now, in place of an answer: Claude reads your message instead of waiting on the card above, and carries on from it."}
            onclick={() => void run(() => sendAsReply(chatKey, row!.id))}>Send now</button
          >
        {/if}
        {#if plan && offersSendNow(st, plan.plan)}
          <button
            class="ns-btn small"
            data-mt="send-now"
            data-plan={plan.plan}
            disabled={working}
            use:tip={sendNowTip(plan.plan, plan.why)}
            onclick={() => void run(() => sendNow(chatKey, row!.id))}>Send now</button
          >
        {/if}
        {#if offersChoice(st, arrive)}
          <button
            class="ns-btn ghost small"
            data-mt="arrive"
            use:tip={"Leave it: Claude reads it at its next step, as it would anyway."}
            onclick={() => (letArrive[row!.id] = true)}>Let it arrive</button
          >
        {/if}
        {#if st !== "replying"}
        <button class="ns-btn ghost small" data-mt="edit" disabled={working} use:tip={"Take it back into the message box to change it"} onclick={() => void run(() => editPending(chatKey, row!.id))}>Edit</button>
        <button class="ns-btn ghost small" data-mt="cancel" disabled={working} use:tip={"Do not send it"} onclick={() => (confirming = true)}>Cancel</button>
        {/if}
      {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  .midturn {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    margin: 14px 0;
  }
  /* Item 478: taken by the turn, it is drawn inside the reply (640 px at
     most), but sits where his own messages sit — the right edge of the
     turns' column (`.inner`, the transcript's `turns` container), not the
     reply's. Only where that container is; elsewhere it keeps the reply's. */
  @container turns (min-width: 0px) {
    .midturn:not(.pending) {
      width: 100cqw;
    }
  }
  .mt-key {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mt-state {
    font-size: 11.5px;
    color: var(--dim);
  }
  .pending .mt-bubble {
    opacity: 0.55;
    filter: saturate(0.5);
  }
  .pending .mt-bubble :global(.user-bubble) {
    border: 1px dashed var(--line2, var(--line));
  }
  .mt-mark {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--dim);
    border-top-color: transparent;
    animation: mt-spin 900ms linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .mt-mark {
      animation: none;
      border-top-color: var(--dim);
      border-style: dotted;
    }
  }
  @keyframes mt-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .mt-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
  }
  .mt-ask {
    font-size: 12px;
    color: var(--ink);
  }
  /* Item 549: the icon row sits tight under the bubble. */
  .fil .mt-actions {
    gap: 2px;
  }
  .fil .mt-bubble {
    max-width: 100%;
    min-width: 0;
  }
  /* The greying is the bubble's, not its "more" (which stays readable). */
  .fil.pending .mt-bubble {
    opacity: 1;
    filter: none;
  }
  .fil.pending .mt-bubble :global(.user-bubble) {
    opacity: 0.55;
    filter: saturate(0.5);
  }
  /* A held row waits on him, not on a turn: a still ring, not a spinner. */
  .mt-mark.still {
    animation: none;
    border-top-color: var(--dim);
    border-style: dotted;
  }
</style>
