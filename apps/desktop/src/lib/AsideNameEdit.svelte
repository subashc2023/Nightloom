<script lang="ts">
  /**
   * The box an aside is renamed in (item 265): the aside tab's title, a
   * sidebar row, a row of the asides list. Enter or leaving the box keeps
   * what is typed (blank clears the name, and the thread is called by its
   * first question again); Escape leaves the name as it was. The chat
   * rows' rename does the same.
   */
  import { onMount } from "svelte";
  import { ASIDE_NAME_MAX } from "./asides";

  let {
    value,
    placeholder = "Name this aside",
    oncommit,
    oncancel,
  }: {
    value: string;
    placeholder?: string;
    oncommit: (v: string) => void;
    oncancel: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let text = $state(value);
  let box = $state<HTMLInputElement | null>(null);
  let done = false;
  function commit() {
    if (done) return;
    done = true;
    oncommit(text);
  }
  function cancel() {
    if (done) return;
    done = true;
    oncancel();
  }
  onMount(() => {
    box?.focus();
    box?.select();
  });
</script>

<input
  class="aside-name-edit"
  aria-label="Aside name"
  maxlength={ASIDE_NAME_MAX}
  {placeholder}
  bind:this={box}
  bind:value={text}
  onblur={commit}
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }}
/>

<style>
  .aside-name-edit {
    flex: 1;
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    padding: 0.3rem 0.45rem;
    font: inherit;
    font-size: 0.8rem;
    color: var(--text, var(--ink));
    background: var(--bg, var(--paper));
    border: 1px solid var(--accent);
    border-radius: 4px;
  }
  .aside-name-edit:focus {
    outline: none;
  }
</style>
