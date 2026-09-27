// Backlog 245 harness — see usertokens.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import Transcript from "../src/lib/Transcript.svelte";
import { app } from "../src/lib/state.svelte";
import type { SessionEvent } from "../src/lib/types";

const cap = document.getElementById("cap")!;
const at = new Date(Date.now() - 5 * 60_000).toISOString();
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });
const reply = (text: string, input: number, output: number): SessionEvent =>
  ({
    event: "assistant_message",
    model: "claude-opus-5-5",
    blocks: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: input, output_tokens: output },
    at,
  }) as SessionEvent;

app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
app.activeSessionId = "s";
app.events = [
  user("Can you ensure that each subagent's whole transcript is not sent back to the main agent?"),
  reply("Yes — measured, and fixed: only the Agent result goes back now.", 25_593, 812),
  user("And add a token count under my messages too."),
  reply("Done: the same figure the reply shows, under your message.", 26_784, 240),
  user("Here is a long paste. " + "The watermark advances only on success. ".repeat(900)),
  reply("Read it.", 36_970, 90),
  user("One more question, still waiting for its reply."),
];
mount(Transcript, { target: document.getElementById("root")!, props: {} });
flushSync();
setTimeout(() => {
  const figs = [...document.querySelectorAll<HTMLElement>(".user-turn .turn-foot .turn-size")].map((e) => e.textContent!.replace(/\s+/g, " ").trim());
  const head = document.querySelectorAll(".user-key .turn-size").length;
  const replies = [...document.querySelectorAll<HTMLElement>(".footer .meta")].map((e) => e.textContent!.trim()).filter((t) => /tokens/.test(t));
  cap.textContent = `user foot figures: ${JSON.stringify(figs)}\nuser header figures: ${head}\nreply figures: ${JSON.stringify(replies)}`;
}, 300);
