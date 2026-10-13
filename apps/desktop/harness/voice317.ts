// Backlog 317 harness — see voice317.html.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount } from "svelte";
import Voice from "../src/remote/voice/Voice.svelte";
import type { ApprovalRequest } from "../src/lib/types";

const kind = new URLSearchParams(location.search).get("kind") ?? "call";
const call: ApprovalRequest = {
  id: "t1",
  name: "mcp__nightloom__search_chats",
  input: { query: "away server weather", scope: "all" },
  effect: "read_only",
  chat: "c1",
};
const question: ApprovalRequest = { id: "t2", name: "AskUserQuestion", input: { questions: [] }, effect: "mutating", chat: "c1" };
const approvals = kind === "call" ? [call] : kind === "question" ? [question] : [];
mount(Voice, {
  target: document.getElementById("root")!,
  props: {
    token: "x",
    chat: "c1",
    title: "Weather on the away server",
    still: true,
    preview: {
      state: "thinking",
      heard: "What's the weather like on the away server?",
      note: kind === "frame" ? "I need your OK to use search chats — it's on your screen." : null,
    },
    onclose: () => {},
    approvals,
    onanswer: (r, d) => console.log(r.id, d),
  },
});
