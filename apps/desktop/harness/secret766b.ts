// Item 766 part 2 harness — see secret766b.html. Fixtures only; the backend
// is stubbed: `bw` answers with the state named by &bw=, and the vault holds
// two made-up items (no values: the card never gets one).
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, flushSync, tick } from "svelte";
import SecretCard from "../src/lib/SecretCard.svelte";
import SecretAsk from "../src/remote/SecretAsk.svelte";
import { app } from "../src/lib/state.svelte";
import { applyLook } from "../src/remote/look";
import type { BwApi, BwItem, BwReady } from "../src/lib/secret";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
root.style.setProperty("--w", "100vw");
root.style.setProperty("--h", "100vh");
const state = (q.get("bw") ?? "unlocked") as BwReady;
const items: BwItem[] = [
  { id: "a1", name: "GitHub", host: "github.com", fields: ["password", "username", "field:token"] },
  { id: "b2", name: "GitHub (work)", host: "github.example.com", fields: ["password", "username"] },
];
const input = {
  name: "GITHUB_TOKEN",
  why: "To publish the release. GitHub → Settings → Developer settings → Tokens.",
  command: "gh release create v1.4.0 --notes-file NOTES.md",
};
const req = { id: "toolu_s", name: "mcp__nightloom__request_secret", input, effect: "mutating", chat: "a1b2c3d4" } as never;
(window as unknown as { __stub: (cmd: string) => Promise<unknown> }).__stub = async (cmd: string) => {
  if (cmd === "bitwarden_ready") return state;
  if (cmd === "bitwarden_search") return items;
  return null;
};
const bw: BwApi = {
  ready: async () => state,
  search: async () => items,
  store: async () => {},
};
root.style.background = "var(--bg)";
const col = document.createElement("div");
col.style.cssText =
  "display:flex;flex-direction:column;gap:12px;padding:24px 16px;box-sizing:border-box;width:100%;max-width:820px;margin:auto auto 0;color:var(--ink);font-family:var(--sans)";
root.appendChild(col);
if ((q.get("v") ?? "mac") === "mac") {
  if (q.get("layout") === "classic") document.documentElement.dataset.layout = "classic";
  app.activeSessionId = "a1b2c3d4";
  mount(SecretCard, { target: col, props: { req } });
} else {
  applyLook(q.get("look") === "classic" ? "classic" : "filament");
  root.style.background = "var(--bg)";
  mount(SecretAsk, { target: col, props: { input, onuse: async () => null, ondecline: () => {}, bw, onstored: async () => null } });
}
flushSync();
// Let the card's status and search land, then pick the first item's token.
setTimeout(async () => {
  await tick();
  if (q.get("pick")) {
    (col.querySelector(".bw-item") as HTMLButtonElement | null)?.click();
    flushSync();
    const chips = [...col.querySelectorAll(".bw-fields .chip")] as HTMLButtonElement[];
    chips.find((c) => c.textContent === "token")?.click();
    flushSync();
  }
}, 50);
