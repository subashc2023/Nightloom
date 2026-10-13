// Item 334 harness — see speech334.html.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount } from "svelte";
import SpeechTest from "../src/remote/voice/SpeechTest.svelte";

mount(SpeechTest, { target: document.getElementById("root")! });
