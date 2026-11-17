<script lang="ts">
  /**
   * Lock-on (items 713 + 753, his pick, blocker 2031): the corner brackets, the scanline and the veil that
   * arrive with a "Claude asks you" card — and with the Needs-you view. Drawn inside the card's shell (which is
   * `position: relative` and carries `lk-shell`); the look is app.css §"ask lock-on", gated there: brackets wear
   * `--bracket` (transparent under calm and Classic), and only Jarvis with motion allowed animates. On mount, in
   * Jarvis, the shell's header decodes (`decodeAt`) through a `data-decode` overlay — the header's own text is
   * never touched.
   */
  import { onMount } from "svelte";
  import { ARRIVE, decodeAt, look } from "./askMotion";

  let { header = ".aq-one, .aq-tab.on" }: { header?: string } = $props();
  let me = $state<HTMLElement | null>(null);

  onMount(() => {
    if (look() !== "jarvis") return;
    const h = me?.parentElement?.querySelector<HTMLElement>(header);
    // Its own words only (the "?" glyph is a child element and stays as it is).
    const text = h
      ? [...h.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? "")
          .join("")
          .trim()
      : "";
    if (!h || !text) return;
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const ms = performance.now() - t0;
      if (ms >= ARRIVE.decodeTo) {
        h.removeAttribute("data-decode");
        return;
      }
      h.setAttribute("data-decode", decodeAt(text, ms));
      raf = requestAnimationFrame(step);
    };
    step();
    return () => {
      cancelAnimationFrame(raf);
      h.removeAttribute("data-decode");
    };
  });
</script>

<i class="lk lk-veil" aria-hidden="true" bind:this={me}></i>
<i class="lk lk-scan" aria-hidden="true"></i>
<i class="lk lk-br tl" aria-hidden="true"></i>
<i class="lk lk-br tr" aria-hidden="true"></i>
<i class="lk lk-br bl" aria-hidden="true"></i>
<i class="lk lk-br br" aria-hidden="true"></i>
