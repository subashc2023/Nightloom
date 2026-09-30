<script lang="ts">
  /**
   * A council turn from the phone (item 246, wave 2C): the message in the
   * composer goes to several seats at once — each a model answering on its
   * own — and the chair joins them, as the Mac's council button does. The
   * seats and the mode start from the Mac's rail (`council` on `/api/rail`)
   * and his last choice here.
   *
   * The message is the composer's draft, which is kept as he types; the
   * sheet never holds text of its own, so nothing here can be lost.
   */
  import { untrack } from "svelte";
  import { COUNCIL_MODELS, MAX_SEATS, councilProblem, type CouncilSeat, type CouncilSend } from "./client";

  interface Props {
    /** The host takes a council on a send (`features`). */
    available: boolean;
    /** The rail's seats and mode, if the Mac said. */
    initial: { seats: CouncilSeat[]; mode: "answer" | "disproof" } | null;
    /** The composer's text. */
    text: string;
    /** Why sending now is not possible (a turn running, offline), or null. */
    blocked: string | null;
    problem: string | null;
    onsend: (council: CouncilSend) => Promise<boolean>;
  }
  let { available, initial, text, blocked, problem, onsend }: Props = $props();

  const LAST = "nightloom.remote.council";
  function remembered(): { seats: CouncilSeat[]; mode: "answer" | "disproof" } | null {
    try {
      const v = JSON.parse(localStorage.getItem(LAST) ?? "null");
      if (v && Array.isArray(v.seats) && v.seats.every((s: unknown) => s && typeof (s as CouncilSeat).model === "string"))
        return { seats: v.seats, mode: v.mode === "disproof" ? "disproof" : "answer" };
    } catch {
      // nothing kept
    }
    return null;
  }
  // Read once: the seats are his to change from here on.
  const start = remembered() ?? untrack(() => initial) ?? { seats: [{ model: "opus" }, { model: "sonnet" }], mode: "answer" as const };
  let seats = $state<CouncilSeat[]>(start.seats.map((s) => ({ ...s })));
  let mode = $state<"answer" | "disproof">(start.mode);
  let sending = $state(false);

  const bad = $derived(councilProblem(seats));

  function keep() {
    try {
      localStorage.setItem(LAST, JSON.stringify({ seats, mode }));
    } catch {
      // per-page only
    }
  }

  function setSeat(i: number, model: string) {
    seats = seats.map((s, k) => (k === i ? { ...s, model } : s));
    keep();
  }

  async function send() {
    if (bad || !text.trim() || blocked) return;
    sending = true;
    try {
      keep();
      await onsend({ seats, mode, areas: [] });
    } finally {
      sending = false;
    }
  }
</script>

<div class="cs-title">Ask the council</div>
<div class="cs-sub">Each seat answers on its own; a chair joins the answers.</div>
{#if !available}
  <p class="cs-note">This Mac's Nightloom is older than the phone page: update it to run a council from here.</p>
{:else}
  <div class="cs-seg" role="radiogroup" aria-label="What the council does">
    <button role="radio" aria-checked={mode === "answer"} class:on={mode === "answer"} onclick={() => ((mode = "answer"), keep())}>
      Answer<small>research, with sources</small>
    </button>
    <button role="radio" aria-checked={mode === "disproof"} class:on={mode === "disproof"} onclick={() => ((mode = "disproof"), keep())}>
      Disproof<small>what exists, what contradicts</small>
    </button>
  </div>
  <div class="cs-seats">
    {#each seats as s, i (i)}
      <div class="cs-seat">
        <span class="cs-n">{i + 1}</span>
        <div class="cs-pills">
          {#each COUNCIL_MODELS as m (m)}
            <button class:on={s.model === m} onclick={() => setSeat(i, m)}>{m}</button>
          {/each}
          {#if !COUNCIL_MODELS.includes(s.model)}<button class="on">{s.model}</button>{/if}
        </div>
        <button class="cs-x" aria-label="Remove seat {i + 1}" onclick={() => ((seats = seats.filter((_, k) => k !== i)), keep())}>×</button>
      </div>
    {/each}
  </div>
  <button class="cs-link" disabled={seats.length >= MAX_SEATS} onclick={() => ((seats = [...seats, { model: "sonnet" }]), keep())}>+ Add a seat</button>
  <div class="cs-quote" class:empty={!text.trim()}>{text.trim() || "Type the message in the box first — the council answers it."}</div>
  {#if bad}<p class="cs-problem">{bad}</p>{/if}
  {#if problem}<p class="cs-problem">{problem}</p>{:else if blocked}<p class="cs-note">{blocked}</p>{/if}
  <div class="cs-actions">
    <span class="cs-grow"></span>
    <button class="cs-btn accent" disabled={!!bad || !text.trim() || !!blocked || sending} onclick={send}>Send to {seats.length} seats</button>
  </div>
{/if}

<style>
  .cs-title {
    font-weight: 600;
    font-size: 17px;
  }
  .cs-sub,
  .cs-note {
    font-size: 13px;
    color: var(--dim);
    margin: -6px 0 0;
  }
  .cs-note {
    margin: 0;
  }
  .cs-problem {
    font-size: 14px;
    color: var(--failed);
    margin: 0;
  }
  .cs-seg {
    display: flex;
    gap: 8px;
  }
  .cs-seg button {
    all: unset;
    flex: 1;
    cursor: pointer;
    border: 1px solid var(--line2);
    border-radius: 12px;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    font-size: 15px;
    font-weight: 600;
  }
  .cs-seg button.on {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  small {
    font-size: 12px;
    font-weight: 400;
    color: var(--dim);
  }
  .cs-seats {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 16px;
    overflow: hidden;
  }
  .cs-seat {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 14px;
    min-height: 48px;
    box-sizing: border-box;
  }
  .cs-seat + .cs-seat {
    border-top: 1px solid var(--line);
  }
  .cs-n {
    width: 16px;
    color: var(--dim);
    font-size: 13px;
    flex: none;
  }
  .cs-pills {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }
  .cs-pills button {
    all: unset;
    cursor: pointer;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid var(--line2);
    font-size: 14px;
  }
  .cs-pills button.on {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .cs-x {
    all: unset;
    cursor: pointer;
    width: 36px;
    height: 36px;
    text-align: center;
    line-height: 36px;
    font-size: 20px;
    color: var(--dim);
    flex: none;
  }
  .cs-link {
    all: unset;
    cursor: pointer;
    color: var(--accent-ink);
    font-size: 15px;
    padding: 4px 4px;
    align-self: flex-start;
  }
  .cs-link:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .cs-quote {
    font-size: 14px;
    color: var(--ink2);
    background: var(--paper);
    border-radius: 12px;
    padding: 8px 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .cs-quote.empty {
    color: var(--dim);
  }
  .cs-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .cs-grow {
    flex: 1;
  }
  .cs-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 16px;
    display: inline-flex;
    align-items: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
  }
  .cs-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .cs-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
</style>
