<script lang="ts">
  // The pre-arm card (nightshift item 826): the Always rules, all ticked,
  // and an end time; one Touch ID fetches only the ticked values, holds them
  // for the run until that time (surviving a screen lock), and the vault
  // locks again at once. Never a value here: names and the end only.
  import * as api from "./api";
  import { ARM_TIP, DEFAULT_END, armBlocked, armedLine, nextClock, untilWords } from "./bitwardenArm";
  import { tip } from "./tip";

  let {
    rules,
    status,
    onchange,
  }: { rules: api.BitwardenRule[] | null; status: api.BitwardenTouchStatus | null; onchange: () => void } = $props();

  let off = $state<Set<string>>(new Set());
  let endText = $state(DEFAULT_END);
  let busy = $state(false);
  let note = $state<string | null>(null);
  let now = $state(new Date());

  $effect(() => {
    const t = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(t);
  });

  const picked = $derived((rules ?? []).filter((r) => !off.has(r.id)));
  const end = $derived(nextClock(now, endText, 5 * 60 * 1000));
  const blocked = $derived(armBlocked(picked.length, end, !!status?.stored));
  const line = $derived(armedLine(status?.armed ?? null, now));

  function flip(id: string) {
    const s = new Set(off);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    off = s;
  }

  async function arm() {
    if (busy || blocked || !end) return;
    busy = true;
    note = null;
    try {
      await api.bitwardenArm(
        picked.map((r) => r.id),
        end.toISOString(),
      );
    } catch (e) {
      note = String(e).replace(/^Error:\s*/, "");
    } finally {
      busy = false;
      onchange();
    }
  }

  async function disarm() {
    await api.bitwardenDisarm().catch(() => {});
    onchange();
  }
</script>

<div class="arm" role="group" aria-label="Pre-arm Bitwarden for a run">
  {#if line}
    <p class="note small" role="status">{line}</p>
    <div class="row"><button class="ns-btn ghost small" onclick={() => void disarm()}>End now</button></div>
  {:else if rules === null}
    <p class="note small">Reading…</p>
  {:else if rules.length === 0}
    <!-- Item 917: says what pre-arming is for and where its list comes from. -->
    <p class="note small">
      Nothing to pre-arm yet. Before an overnight or away run, you pick here which secrets it may use — only the secrets
      given without asking (above) can be picked, and there are none yet.
    </p>
  {:else}
    <ul class="picks">
      {#each rules as r (r.id)}
        <li>
          <label><input type="checkbox" checked={!off.has(r.id)} disabled={busy} onchange={() => flip(r.id)} /> <b class="sub-mono">{r.name}</b> from {r.item_name}, for <code>{r.prefix}</code></label>
        </li>
      {/each}
    </ul>
    <div class="row">
      <label class="end">Until <input type="time" bind:value={endText} disabled={busy} aria-label="Pre-arm end time" /></label>
      {#if end && untilWords(end, now).endsWith("tomorrow")}<span class="note small">tomorrow</span>{/if}
      <span use:tip={blocked ?? ARM_TIP}>
        <button class="ns-btn accent small" disabled={busy || !!blocked} onclick={() => void arm()}>Pre-arm with Touch ID</button>
      </span>
    </div>
    {#if blocked}<p class="note small">{blocked}</p>{/if}
  {/if}
  {#if note}<p class="note small err" role="status">{note}</p>{/if}
</div>

<style>
  .arm {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .picks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .end {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 13px;
  }
  /* Item 917: Settings' `.note.small` is scoped to SettingsModal, so this
     part's notes and empty state drew at the body size; the same look here. */
  .note {
    margin: 0;
    color: var(--dim);
    font-size: 12px;
    line-height: 1.45;
  }
  :global(:where(:root:not([data-layout="classic"]))) .note {
    font-size: 12.5px;
  }
  .note.err {
    color: var(--failed);
  }
</style>
