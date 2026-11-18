// Item 795: the Quick Entry box's page — a third entry of the build
// (vite.config.ts), opened by `quick_entry.rs` as a non-activating panel.
import { mount } from "svelte";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import QuickEntry from "./QuickEntry.svelte";

export default mount(QuickEntry, { target: document.getElementById("app")! });
