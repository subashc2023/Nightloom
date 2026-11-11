// The phone page's entry (nightshift backlog 091, Shape B): `remote.html`
// mounts this; the desktop's `main.ts` is untouched. No Tauri API here —
// the page runs in Safari on the phone and talks HTTP to the listener.
import { mount } from "svelte";
import Remote from "./Remote.svelte";
import { installMathCopy } from "../lib/mathCopy";
import { applyLook, loadLook } from "./look";
import { hostsAtLoad, manifestHref, setManifest } from "./homeScreen";
import { loadHosts, pair } from "./hosts";
// The desktop's type (item 246): IBM Plex Sans and Mono, bundled so the
// phone draws them without a font request off the tailnet.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";

// Item 352: copying a rendered formula gives its TeX, as on the desktop.
installMathCopy();

// Item 572: the phone's own look on <html> before the first paint.
applyLook(loadLook());

// Item 604: the manifest link before anything else can ask for it — the
// Home Screen icon's own manifest once paired (`homeScreen.ts`); WebKit
// loads a page's manifest once, from the link there when it is asked.
setManifest(document, manifestHref(hostsAtLoad(loadHosts(location.origin), location.hash, location.origin, pair), location.origin));

mount(Remote, { target: document.getElementById("app")! });
