// The phone page's entry (nightshift backlog 091, Shape B): `remote.html`
// mounts this; the desktop's `main.ts` is untouched. No Tauri API here —
// the page runs in Safari on the phone and talks HTTP to the listener.
import { mount } from "svelte";
import Remote from "./Remote.svelte";

mount(Remote, { target: document.getElementById("app")! });
