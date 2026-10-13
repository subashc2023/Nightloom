<script lang="ts" module>
  /*
   * A layer's own text for one chat, edited from the phone (item 246, wave
   * 2B; the Mac's version is nightshift backlog 057 in `ContextPanel.svelte`).
   *
   * The half-typed text lives in localStorage from the first keystroke
   * (practices §7, memory `never-lose-work-in-the-ui`): the Close button, a
   * swipe back, a reload, the phone killing the tab — none of them drops it.
   * Only Save (the Mac took it) and Discard (asked first) do. An editor
   * closed untouched keeps nothing. Keyed by chat and layer, like the Mac's
   * `layerDrafts.svelte.ts`, so a draft for one chat never opens in another.
   */

  export const LAYER_DRAFTS_KEY = "nightloom.remote.layerDrafts";

  /** One held draft: what he typed, and what the editor opened with (so a
   *  Discard asks only when there is a real change, and "restored" can say
   *  whether the Mac's text moved underneath). */
  export interface LayerDraft {
    text: string;
    base: string;
    /** Unix ms of the last keystroke. */
    at: number;
  }

  type Drafts = Record<string, LayerDraft>;

  function store(s?: Storage | null): Storage | null {
    if (s !== undefined) return s;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }

  const keyOf = (chat: string, kind: string) => `${chat}\n${kind}`;

  function readAll(s: Storage | null): Drafts {
    if (!s) return {};
    try {
      const v = JSON.parse(s.getItem(LAYER_DRAFTS_KEY) ?? "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Drafts) : {};
    } catch {
      return {};
    }
  }

  function writeAll(s: Storage | null, all: Drafts): boolean {
    if (!s) return false;
    try {
      if (Object.keys(all).length === 0) s.removeItem(LAYER_DRAFTS_KEY);
      else s.setItem(LAYER_DRAFTS_KEY, JSON.stringify(all));
      return true;
    } catch {
      return false;
    }
  }

  /** The draft held for `kind` in `chat`, or null. */
  export function heldLayerDraft(chat: string, kind: string, s?: Storage | null): LayerDraft | null {
    const d = readAll(store(s))[keyOf(chat, kind)];
    return d && typeof d.text === "string" && typeof d.base === "string" ? d : null;
  }

  /** The layers of `chat` with a draft held, oldest keystroke first. */
  export function heldLayerKinds(chat: string, s?: Storage | null): string[] {
    const prefix = `${chat}\n`;
    return Object.entries(readAll(store(s)))
      .filter(([k]) => k.startsWith(prefix))
      .sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))
      .map(([k]) => k.slice(prefix.length));
  }

  /**
   * Keep what is typed. Text equal to what the editor opened with is not a
   * draft (an untouched editor keeps nothing), so it drops any held one.
   * Returns false when the phone would not store it (private mode, full),
   * which the editor says rather than pretending.
   */
  export function holdLayerDraft(
    chat: string,
    kind: string,
    text: string,
    base: string,
    now = Date.now(),
    s?: Storage | null,
  ): boolean {
    const st = store(s);
    const all = readAll(st);
    if (text === base) delete all[keyOf(chat, kind)];
    else all[keyOf(chat, kind)] = { text, base, at: now };
    return writeAll(st, all);
  }

  export function dropLayerDraft(chat: string, kind: string, s?: Storage | null): void {
    const st = store(s);
    const all = readAll(st);
    if (!(keyOf(chat, kind) in all)) return;
    delete all[keyOf(chat, kind)];
    writeAll(st, all);
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";

  interface Props {
    /** The chat the text belongs to. */
    chat: string;
    kind: string;
    /** The layer's name, as the card says it. */
    label: string;
    /** What the editor opens with when no draft is held: the chat's own
     *  text, or the file's. */
    seed: string;
    /** Where the seed came from, said under the title. */
    seedNote: string;
    /** A turn runs in this chat: the Mac refuses the change until it ends. */
    busy: boolean;
    /** Send the text to the Mac; resolves to null when it took it, or the
     *  Mac's sentence when it did not (the draft is then kept). */
    onsave: (text: string) => Promise<string | null>;
    /** The editor closes. The draft, if any, stays held. */
    onclose: () => void;
  }
  let { chat, kind, label, seed, seedNote, busy, onsave, onclose }: Props = $props();

  let text = $state("");
  let base = $state("");
  let restored = $state(false);
  /** The Mac's text moved since the draft began (another save, a file
   *  edit): said, never merged. */
  let moved = $state(false);
  let saving = $state(false);
  let problem = $state<string | null>(null);
  let confirmDiscard = $state(false);
  let unsaved = $state(false);

  onMount(() => {
    const held = heldLayerDraft(chat, kind);
    if (held) {
      text = held.text;
      base = held.base;
      restored = true;
      moved = held.base !== seed;
    } else {
      text = seed;
      base = seed;
    }
  });

  const changed = $derived(text !== base);

  function input() {
    // Every keystroke, not on close: a killed tab has no close.
    unsaved = !holdLayerDraft(chat, kind, text, base);
  }

  async function save() {
    if (saving) return;
    saving = true;
    problem = null;
    const err = await onsave(text);
    saving = false;
    if (err === null) {
      dropLayerDraft(chat, kind);
      onclose();
    } else {
      // The draft is already held; the sentence says why it did not go.
      problem = err;
    }
  }

  function discard() {
    confirmDiscard = false;
    dropLayerDraft(chat, kind);
    onclose();
  }
</script>

<div class="le" role="dialog" aria-modal="true" aria-label={`${label} for this chat`}>
  <header class="le-top">
    <button class="le-btn" onclick={onclose} disabled={saving}>Close</button>
    <div class="le-title">
      <span class="le-name">{label}</span>
      <small>{changed ? "draft kept on this phone" : "for this chat"}</small>
    </div>
    <button class="le-btn accent" onclick={save} disabled={saving || busy || !changed}>{saving ? "Saving…" : "Save"}</button>
  </header>

  <div class="le-notes">
    {#if restored}
      <p class="le-note">Your draft from before{moved ? " — the Mac's text has changed since you began it; Save replaces it with this" : ""}.</p>
    {:else}
      <p class="le-note">{seedNote}</p>
    {/if}
    {#if busy}<p class="le-note">A turn is running in this chat — Save once it ends. Your text is kept.</p>{/if}
    {#if unsaved}<p class="le-bad">This phone would not store the draft (private browsing?) — keep the page open until you save.</p>{/if}
    {#if problem}<p class="le-bad">{problem}</p>{/if}
  </div>

  <textarea
    data-kept={unsaved ? undefined : ""}
    bind:value={text}
    oninput={input}
    spellcheck="false"
    autocapitalize="off"
    aria-label={`${label} text`}
  ></textarea>

  <footer class="le-foot">
    {#if confirmDiscard}
      <span class="le-grow">Throw away your changes?</span>
      <button class="le-btn" onclick={() => (confirmDiscard = false)}>Keep editing</button>
      <button class="le-btn danger" onclick={discard}>Discard</button>
    {:else}
      <span class="le-grow le-dim">{text.length.toLocaleString()} characters · Save applies from the chat's next message</span>
      {#if changed}<button class="le-btn danger" onclick={() => (confirmDiscard = true)} disabled={saving}>Discard…</button>{/if}
    {/if}
  </footer>
</div>

<style>
  .le {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: var(--sheet);
    display: flex;
    flex-direction: column;
    padding: env(safe-area-inset-top, 0px) 0 env(safe-area-inset-bottom, 0px);
  }
  .le-top {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .le-title {
    flex: 1;
    min-width: 0;
    text-align: center;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
  }
  .le-name {
    font-weight: 600;
    font-size: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .le-title small {
    font-size: 12px;
    color: var(--dim);
  }
  .le-notes {
    padding: 0 16px;
  }
  .le-note,
  .le-bad {
    font-size: 13px;
    margin: 8px 0 0;
    color: var(--dim);
  }
  .le-bad {
    color: var(--failed);
  }
  textarea {
    flex: 1;
    min-height: 0;
    margin: 10px 12px;
    padding: 12px;
    border: 1px solid var(--line2);
    border-radius: 12px;
    background: var(--paper);
    color: var(--ink);
    font: 15px/1.5 var(--mono);
    resize: none;
    outline: none;
    box-sizing: border-box;
  }
  textarea:focus {
    border-color: var(--accent);
  }
  .le-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px 10px;
    font-size: 13px;
  }
  .le-grow {
    flex: 1;
    min-width: 0;
  }
  .le-dim {
    color: var(--dim);
  }
  .le-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    border-radius: 12px;
    font-size: 15px;
    box-sizing: border-box;
    flex: none;
  }
  .le-btn:disabled {
    opacity: 0.4;
  }
  .le-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }
  .le-btn.danger {
    color: var(--failed);
  }
</style>
