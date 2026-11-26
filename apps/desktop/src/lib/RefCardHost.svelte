<script lang="ts">
  /**
   * Where the typed link's card lives (item 993c): one host for the whole window, mounted by `App.svelte`. A click
   * (or Return / Space) on any `a.nl-ref` — the chat, Home's reply strip and its full view, a brief, an aside docked
   * or floating, a quote — opens `RefCard` from that link; a click on the same link, Esc, ✕ or a press anywhere
   * outside closes it; a click on another link moves to that one. While the host is mounted the root carries
   * `data-ref-cards`, which is what gives the links their look (refTag.css) — a window without a host (the phone
   * until 993f, Quick Entry) draws the names plain.
   *
   * `act` is 993d's: it is not passed here yet, so the card shows every action disabled, "coming soon".
   */
  import { onMount } from "svelte";
  import RefCard from "./RefCard.svelte";
  import { refFromEl, refKey, type Ref } from "./refTag";
  import { accountOf } from "./refCard";
  import type { RefAction, RefReceipt } from "./refCard";
  import type { HomeReach } from "./home";

  let {
    reach,
    loadReach,
    act,
    onaccounts,
  }: {
    /** What Home reaches, when the app already holds it. */
    reach?: () => HomeReach | null;
    /** Reads the last check (nothing is run) when it does not. */
    loadReach?: () => Promise<HomeReach>;
    act?: (ref: Ref, a: RefAction) => Promise<RefReceipt>;
    onaccounts?: () => void;
  } = $props();

  let open = $state<{ ref: Ref; anchor: HTMLElement; n: number } | null>(null);
  let read = $state<HomeReach | null>(null);
  let seq = 0;
  // The items something was sent for this session: their links keep a ✓.
  const done = new Set<string>();

  const known = $derived(reach?.() ?? read);
  const account = $derived(open ? accountOf(known, open.ref.src) : null);

  function mark(el: HTMLElement | null, cls: string, on: boolean): void {
    if (el?.isConnected) el.classList.toggle(cls, on);
  }

  function show(a: HTMLElement, ref: Ref): void {
    if (open) mark(open.anchor, "ref-open", false);
    open = { ref, anchor: a, n: ++seq };
    mark(a, "ref-open", true);
    if (!reach?.() && !read && loadReach)
      void loadReach()
        .then((r) => (read = r))
        .catch(() => {});
  }

  function close(refocus = true): void {
    if (!open) return;
    const a = open.anchor;
    mark(a, "ref-open", false);
    open = null;
    if (refocus && a.isConnected) a.focus({ preventScroll: true });
  }

  const linkOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("a.nl-ref") : null);

  function toggle(a: HTMLElement, e: Event): boolean {
    const ref = refFromEl(a);
    // A link that does not check out is plain words: nothing opens, and the click is not taken.
    if (!ref) return false;
    e.preventDefault();
    e.stopPropagation();
    if (open?.anchor === a) close();
    else show(a, ref);
    return true;
  }

  onMount(() => {
    const root = document.documentElement;
    root.dataset.refCards = "1";
    const onClick = (e: MouseEvent) => {
      const a = linkOf(e.target);
      if (a && e.button === 0) toggle(a, e);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const a = e.target instanceof HTMLElement && e.target.matches("a.nl-ref") ? e.target : null;
      if (a) toggle(a, e);
    };
    const onDown = (e: PointerEvent) => {
      if (!open) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(".ref-card, .nl-tip")) return;
      // A press on a link is the click's to handle (toggle, or move to another).
      if (linkOf(t)) return;
      close(false);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      delete root.dataset.refCards;
    };
  });

  // The reply was drawn again (a streaming turn, a tab switch) and the link is a new element: the card stays where
  // it is until he closes it; if the link is gone altogether, so is the mark, and nothing else changes.
  function sent(): void {
    if (!open) return;
    done.add(refKey(open.ref));
    mark(open.anchor, "ref-done", true);
  }
</script>

{#if open && account}
  {#key open.n}
    <RefCard
      ref={open.ref}
      anchor={open.anchor}
      account={account.label}
      accountState={account.state}
      act={act ? (a) => act(open!.ref, a) : undefined}
      onclose={() => close()}
      onaccounts={onaccounts ? () => (close(false), onaccounts()) : undefined}
      ondone={sent}
    />
  {/key}
{/if}
