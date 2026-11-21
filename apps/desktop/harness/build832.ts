// Item 832 — see build832.html.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync } from "svelte";
import SettingsModal from "../src/lib/SettingsModal.svelte";
import { setLayout } from "../src/lib/layout.svelte";
import { app } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
setLayout(q.get("classic") === "1" ? "classic" : "filament");
(app as unknown as { searchBackends: unknown[] }).searchBackends = [];
mount(SettingsModal, { target: document.getElementById("root")!, props: {} as never });
flushSync();
// The build line is at the nav's foot: scroll the nav to its end so the shot shows it.
setTimeout(() => {
  const nav = document.querySelector<HTMLElement>(".nav");
  if (nav) nav.scrollTop = nav.scrollHeight;
  const foot = document.querySelector(".nav-foot");
  document.getElementById("cap")!.textContent += ` foot: ${foot?.textContent ?? "missing"}`;
}, 1500);
