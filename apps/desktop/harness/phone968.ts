// Item 968 (review) — see phone968.html. The phone's Nightshift sheet on its project list, the listener stubbed
// (window.fetch answers /api/nightshift), the phone's palettes read from Remote.svelte's own :root blocks (845's way).
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, flushSync } from "svelte";
import remoteSrc from "../src/remote/Remote.svelte?raw";
import NightshiftSheet from "../src/remote/NightshiftSheet.svelte";
import { applyLook } from "../src/remote/look";

const q = new URLSearchParams((window as unknown as { __h9q?: string }).__h9q ?? location.search);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
{
  const out: string[] = [];
  const lines = remoteSrc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*:global\(((?::root|html, body).*)\)\s*\{\s*$/.exec(lines[i]);
    if (!m) continue;
    const body: string[] = [];
    for (i++; i < lines.length && !/^\s*\}\s*$/.test(lines[i]); i++) body.push(lines[i]);
    out.push(`${m[1]} {\n${body.join("\n")}\n}`);
  }
  document.head.insertAdjacentHTML("beforeend", `<style>${out.join("\n")}\nhtml,body{margin:0;background:var(--paper);font-family:var(--sans);color:var(--ink)}</style>`);
}
document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{animation:none!important;transition:none!important}</style>");

// Three projects: 30 open / 5 held (his nightshift-code today), 4 open / 0 held (all decided: no badge), and an older
// service's row with no held_blockers (every open one counts, nothing hidden).
const projects = [
  { id: "p0", name: "nightshift-code", live: false, items: 40, open_blockers: 30, held_blockers: 5, newest_morning: "2026-11-25.md", config_error: null },
  { id: "p1", name: "AISC", live: false, items: 6, open_blockers: 4, held_blockers: 0, newest_morning: null, config_error: null },
  { id: "p2", name: "older-service", live: false, items: 3, open_blockers: 2, newest_morning: null, config_error: null },
];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
window.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const p = url.pathname.replace(/^.*\/api/, "");
  if (p === "/nightshift") return json(projects);
  return json({});
}) as typeof fetch;

try {
  localStorage.clear();
} catch {
  // no storage
}
if (q.get("classic") === "1") applyLook("classic");
mount(NightshiftSheet, { target: document.getElementById("app")!, props: { client: { token: "t", base: "" }, available: true, onnote: () => {} } });
flushSync();
void (async () => {
  await wait(700);
  const badges = [...document.querySelectorAll(".nz-badge")].map((b) => b.textContent?.trim());
  document.getElementById("cap")!.textContent += `badges: ${JSON.stringify(badges)} (expected ["5","2"])`;
})();
