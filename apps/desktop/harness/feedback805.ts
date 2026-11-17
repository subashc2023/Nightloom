// Item 805 harness — see feedback805.html. Fixtures only; the backend is stubbed.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, flushSync } from "svelte";
import FeedbackBox from "../src/lib/FeedbackBox.svelte";
import FeedbackSheet from "../src/remote/FeedbackSheet.svelte";
import { app } from "../src/lib/state.svelte";
import { feedback, keepDraft } from "../src/lib/feedback.svelte";
import { applyLook } from "../src/remote/look";
import { savePhoneFeedback } from "../src/remote/feedbackDraft";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
root.style.setProperty("--w", "100vw");
root.style.setProperty("--h", "100vh");
const words = "The aside's close button is too small on the phone, and when I tap it the half-typed question goes.\n\nIt should ask first, like the main chat does.";
(window as unknown as { __stub: (c: string) => Promise<unknown> }).__stub = async (cmd) => {
  if (cmd === "feedback_targets")
    return [
      { id: "ns", name: "nightshift-code", default: true },
      { id: "hc", name: "HopecraftAI", default: false },
    ];
  return null;
};
if ((q.get("v") ?? "mac") === "mac") {
  if (q.get("layout") === "classic") document.documentElement.dataset.layout = "classic";
  app.sessions = [{ id: "a1b2c3d4", path: "/x", title: "Asides on the phone", first_user: "", user_turns: 4, modified: new Date().toISOString() }] as never;
  app.activeSessionId = "a1b2c3d4";
  app.project = { id: "nl", name: "Nightloom" } as never;
  feedback.draft = { text: q.get("empty") ? "" : words, about: "" };
  keepDraft();
  feedback.targets = [
    { id: "ns", name: "nightshift-code", default: true },
    { id: "hc", name: "HopecraftAI", default: false },
  ];
  if (q.get("sent")) feedback.last = "Feedback sent — item 807 in nightshift-code.";
  feedback.open = true;
  feedback.confirmDiscard = !!q.get("discard");
  mount(FeedbackBox, { target: root });
} else {
  applyLook(q.get("look") === "classic" ? "classic" : "filament");
  savePhoneFeedback(words);
  root.style.background = "var(--bg)";
  const sheet = document.createElement("div");
  sheet.style.cssText = "display:flex;flex-direction:column;gap:12px;padding:16px;background:var(--panel);border-radius:16px 16px 0 0;margin-top:auto;color:var(--ink);font-family:var(--sans)";
  root.appendChild(sheet);
  mount(FeedbackSheet, {
    target: sheet,
    props: {
      client: { feedback: async () => ({ filed: { project: "nightshift-code", item: "807", file: "backlog/807-x.md" }, pending_why: null, saved: null, also_filed: [] }) },
      available: q.get("away") ? false : true,
      host: q.get("away") ? "serve" : "mac",
      chat: "a1b2c3d4",
      chatTitle: "Asides on the phone",
      project: "Nightloom",
      onnote: () => {},
    },
  });
}
flushSync();
