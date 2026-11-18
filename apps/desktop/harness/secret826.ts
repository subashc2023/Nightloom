// Item 826 harness — see secret826.html. Fixtures only; the backend is
// stubbed (no bw, no Keychain, no Touch ID): ?show=card-stored (locked, Touch
// ID set up), card-setup (locked, not set up), settings (Touch ID set up,
// pre-arm card with two Always rules), armed (a pre-arm running).
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, flushSync } from "svelte";
import SecretCard from "../src/lib/SecretCard.svelte";
import BitwardenTouch from "../src/lib/BitwardenTouch.svelte";
import BitwardenPreArm from "../src/lib/BitwardenPreArm.svelte";
import { app } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
const show = q.get("show") ?? "card-stored";
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
root.style.setProperty("--w", "100vw");
root.style.setProperty("--h", "100vh");
const tomorrow8 = new Date();
tomorrow8.setDate(tomorrow8.getDate() + 1);
tomorrow8.setHours(8, 0, 0, 0);
const status = {
  stored: show !== "card-setup",
  session: false,
  armed: show === "armed" ? { names: ["GITHUB_TOKEN", "NPM_TOKEN"], until: tomorrow8.toISOString() } : null,
};
const rules = [
  { id: "r1", name: "GITHUB_TOKEN", item_id: "a1", item_name: "GitHub", field: "field:token", prefix: "gh release create", added: "" },
  { id: "r2", name: "NPM_TOKEN", item_id: "b2", item_name: "npm", field: "password", prefix: "npm publish", added: "" },
];
(window as unknown as { __stub: (cmd: string) => Promise<unknown> }).__stub = async (cmd: string) => {
  if (cmd === "bitwarden_ready") return "locked";
  if (cmd === "bitwarden_touch_status") return status;
  return null;
};
root.style.background = "var(--bg)";
const col = document.createElement("div");
col.style.cssText =
  "display:flex;flex-direction:column;gap:14px;padding:24px 16px;box-sizing:border-box;width:100%;max-width:820px;margin:auto auto 0;color:var(--ink);font-family:var(--sans)";
root.appendChild(col);
if (show.startsWith("card")) {
  app.activeSessionId = "a1b2c3d4";
  const input = {
    name: "GITHUB_TOKEN",
    why: "To publish the release.",
    command: "gh release create v1.4.0 --notes-file NOTES.md",
  };
  const req = { id: "toolu_s", name: "mcp__nightloom__request_secret", input, effect: "mutating", chat: "a1b2c3d4" } as never;
  mount(SecretCard, { target: col, props: { req } });
} else {
  const h = (t: string) => {
    const e = document.createElement("div");
    e.textContent = t;
    e.style.cssText = "font-weight:600;font-size:13px";
    col.appendChild(e);
  };
  h("Touch ID unlock");
  mount(BitwardenTouch, { target: col, props: { status, onchange: () => {} } });
  h("Pre-arm for a run");
  mount(BitwardenPreArm, { target: col, props: { rules, status, onchange: () => {} } });
}
flushSync();
