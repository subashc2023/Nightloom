// The phone page's entry (nightshift backlog 091, Shape B): `remote.html`
// mounts this; the desktop's `main.ts` is untouched. No Tauri API here —
// the page runs in Safari on the phone and talks HTTP to the listener.
import { mount } from "svelte";
import Remote from "./Remote.svelte";
// The desktop's type (item 246): IBM Plex Sans and Mono, bundled so the
// phone draws them without a font request off the tailnet.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";

mount(Remote, { target: document.getElementById("app")! });
