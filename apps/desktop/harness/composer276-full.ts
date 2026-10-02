// Item 276 harness — see composer276-full.html.
import "../src/app.css";
import "katex/dist/katex.min.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount } from "svelte";
import Composer from "../src/lib/Composer.svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
composerFormat.on = q.get("format") !== "0";
app.activeSessionId = "chat-a";
app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
mount(Composer, { target: document.getElementById("root")!, props: {} });
(window as unknown as { __app: typeof app }).__app = app;
