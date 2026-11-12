// Item 622b: first, so its startup-log mark is the window's first script line.
import "./bootMark";
import { mount } from "svelte";
import App from "./App.svelte";
// The three faces the redesign uses, bundled rather than fetched: a desktop
// app's type must not depend on the network. Latin subsets only for the two
// Plex faces (the package has no Latin-only sheet for the variable serif,
// whose other scripts are small); the serif carries its own italic file.
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource/ibm-plex-sans/latin-300.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./app.css";
// Item 618b: the composer row's looks, after app.css (the designs harness's order, so app.css never wins a tie).
import "./composerRow.css";
// Item 596: the cache on the message box's frame, after the row's looks.
import "./cacheLook.css";
// Item 644: the box by the chat's model family (Opus Copper, Fable Lilac glass), last, so it wins the card's ties.
import "./modelFamily.css";
import { app as state, applyPalette } from "./lib/state.svelte";
import { applyLayout } from "./lib/layout.svelte";
import { installMathCopy } from "./lib/mathCopy";
import { installFieldUndo } from "./lib/fieldUndo";

// Item 352: copying a rendered formula gives its TeX.
installMathCopy();

// Item 421: ⌘Z in a plain field undoes that field, never another box.
installFieldUndo();

// The saved palette, before the first paint.
applyPalette(state.palette);

// The saved layout (item 542): Filament IV, or Classic — the look before
// item 525 — which stamps `data-layout` and re-stamps the palette.
applyLayout();

// Filament IV's strength, before the first paint (item 525): lit (IV+) is the
// default and needs no attribute; "calm" turns the light, the brackets and
// the dot ground off (`[data-light="calm"]` in app.css). Read from
// localStorage until the Appearance stage gives it a switch.
try {
  if (localStorage.getItem("nightloom.light") === "calm") document.documentElement.dataset.light = "calm";
} catch {
  // No storage (a harness, a private window): the default stands.
}

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
