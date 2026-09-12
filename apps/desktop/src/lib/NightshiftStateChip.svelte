<script lang="ts">
  /**
   * The Nightshift state chip — `live` with the running shift, or the last
   * shift as a word in its colour with how long ago. One component for the
   * header's Review row and the Start tab row (they were two copies that had
   * to be flipped together).
   */
  import { app, latestShift } from "./state.svelte";
  import { pillClass, shiftWord } from "./nightshift";
  import { relativeTime } from "./time";
  import Icon from "./Icon.svelte";

  const row = $derived(app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null);
  const info = $derived(row?.nightshift ?? null);
  const latest = $derived(latestShift());

  /**
   * The state chip: `live` with the running shift, or the last shift as a
   * word — done / partial / failed / interrupted / unknown, the same word
   * and colour the Runs page gives it (`shiftWord`, `pillClass`) — with how
   * long ago it ended. The raw exit code lives in the tooltip; Swaraag read
   * "exit 0" as noise (2026-09-11 review).
   */
  const state = $derived.by(() => {
    if (info?.live) {
      const id = latest?.live ? latest.id : (info.latest_shift ?? "");
      return { word: "live", text: "live", tip: id ? `shift ${id} is running` : "a shift is running" };
    }
    if (!latest) {
      return info?.latest_shift
        ? { word: "unknown", text: "last shift unreadable", tip: `last shift ${info.latest_shift}` }
        : { word: "grey", text: "no shifts yet", tip: "no shift has run on this project" };
    }
    const word = shiftWord(latest);
    const stamp = latest.status?.updated ?? latest.status?.started ?? null;
    const when = stamp ? relativeTime(stamp) : "";
    const exit = latest.status?.exit;
    const tip = `last shift ${latest.id}${exit != null ? ` · exit ${exit}` : ""}${latest.status?.units?.length != null ? ` · ${latest.status.units.length} unit(s)` : ""}`;
    return { word, text: `last shift ${word}${when ? ` · ${when}` : ""}`, tip };
  });
</script>

<span class="ns-chip" title={state.tip}>
  <Icon name="moon" />
  <span class="ns-pill {pillClass(state.word)}"><span class="dot"></span>{state.text}</span>
</span>

<style>
  .ns-chip {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
