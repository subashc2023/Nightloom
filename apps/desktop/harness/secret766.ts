// Item 766 harness — see secret766.html. Fixtures only; the backend is stubbed.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, flushSync } from "svelte";
import SecretCard from "../src/lib/SecretCard.svelte";
import SecretAsk from "../src/remote/SecretAsk.svelte";
import { app } from "../src/lib/state.svelte";
import { applyLook } from "../src/remote/look";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
root.style.setProperty("--w", "100vw");
root.style.setProperty("--h", "100vh");
const input = { name: "GITHUB_TOKEN", why: "To push the wave-s-766 branch. GitHub → Settings → Developer settings → Tokens." };
const req = { id: "toolu_s", name: "mcp__nightloom__request_secret", input, effect: "mutating", chat: "a1b2c3d4" } as never;
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
  mount(SecretAsk, { target: col, props: { input, onuse: async () => null, ondecline: () => {} } });
}
flushSync();
// A typed value, shown hidden (or in the clear with &shown=1), so the shot
// shows the field as he sees it mid-entry.
const field = col.querySelector("input") as HTMLInputElement | null;
if (field) {
  field.value = "ghp_example_not_real_0000";
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
if (q.get("shown")) (col.querySelector("button.show, button.sa-btn.quiet") as HTMLButtonElement | null)?.click();
flushSync();
