import { mount } from "svelte";
import App from "./App.svelte";
// The three faces the redesign uses, bundled rather than fetched: a desktop
// app's type must not depend on the network. Latin subsets only for the two
// Plex faces (the package has no Latin-only sheet for the variable serif,
// whose other scripts are small); the serif carries its own italic file.
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./app.css";
import { app as state, applyPalette } from "./lib/state.svelte";

// The saved palette, before the first paint.
applyPalette(state.palette);

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
