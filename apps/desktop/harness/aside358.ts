// Backlog 358 harness — see aside358.html.
import "../src/app.css";
import "katex/dist/katex.min.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import AsideCard from "../src/lib/AsideCard.svelte";
import AsideView from "../src/lib/AsideView.svelte";
import { app, draftAside } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";

// The Tauri bridge, faked: nothing answers.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async () => null,
  transformCallback: () => 0,
};

const q = new URLSearchParams(location.search);
const v = q.get("v") ?? "card";
const w = Number(q.get("w") ?? 520);
const asking = q.get("asking") === "1";
document.documentElement.dataset.palette = q.get("p") ?? "A";
composerFormat.on = true;
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;

// His chat had no title yet: the aside names it by its first prompt, all of it.
const PROMPT =
  "I want you to do a pretty comprehensive review and research all of the best AI safety grants. That a new organization could apply for. Stuart Armstrong has officially had his UK startup Hopecraft AI Unlimited Officially, a company, which means he's looking for funding. Now, he's not sure whether he wants to go the non-profit or for-profit route, and so obviously the grants that don't preclude a for-profit transition down the road are the best case. Other things he's looking for are VCs and like the best recommendations on the best way to approach VCs. For the record, he has already applied to Tailwind and they got back to him with a personalized application, which is he is now working on. So if it includes any advice on that, great, not necessary tho obviously. But yeah, we're just looking for really any sort of funding opportunities that could be possible because if so, that would be greatly useful. use subagents if u'd like, up to u.";
app.sessions = [{ id: "chat-a", title: null, first_user: PROMPT }] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code", workspace: "/tmp" } as unknown as typeof app.connection;
app.activeSessionId = "chat-a";
app.draft.engine = "claude-code";
app.draft.agentModel = "opus";
app.draft.agentEffort = "high";

const ANSWER = [
  "Neither. It's **speedrun's standard published deal**, the same terms for every company it accepts. Fareed didn't offer it, and it's not something Stuart should propose.",
  "It matters because Fareed works on speedrun. If his enthusiasm turns into an investment, the most likely route is speedrun, so those would likely be the terms:",
  "- **$500K now, for 10% of the company.** That values Hopecraft at $5M once the money is in.\n- **Another $500K later,** put into Hopecraft's next funding round.\n- **The catch:** 12 weeks in person in San Francisco (Feb to Apr 2027), with applications closing **Nov 1**.",
  "So the question for Stuart is whether he wants the program at all, not whether to ask for it.",
].join("\n\n");
const a = draftAside(null as unknown as Parameters<typeof draftAside>[0], null)!;
a.draft = false;
a.turns.push({
  seq: 1,
  question:
    "Wait what's the offer? Is that something you're saying that i should tell stuart he sould propose to fareed? or is this some like informationa bout fareed himself",
  partial: asking ? ANSWER.slice(0, 260) : ANSWER,
  answer: asking ? null : ANSWER,
  error: null,
  cancelled: false,
  cacheRead: 188_342,
  model: asking ? undefined : "claude-opus-5-5",
  usage: asking ? undefined : { input_tokens: 190_000, output_tokens: 240, cache_read_tokens: 188_342 },
  at: asking ? undefined : new Date().toISOString(),
});

if (v === "tab") {
  root.style.flexDirection = "column";
  mount(AsideView, { target: root, props: { session: "chat-a", thread: a.id } });
} else {
  // The chat's column (760 px, centred as the transcript's), the card in it.
  root.innerHTML = `<div style="flex:1;display:flex;flex-direction:column;overflow:hidden"><div id="col" style="position:relative;flex:1;max-width:760px;width:100%;margin:0 auto;padding:24px 0;display:flex;flex-direction:column;justify-content:flex-end;color:var(--ink);font:15px/1.6 var(--sans)">
    <p>${"The chat's reply sits here, and the aside card over it. ".repeat(6)}</p></div></div>`;
  const col = document.getElementById("col")!;
  mount(AsideCard, {
    target: col,
    props:
      v === "foot"
        ? { aside: a, placement: null }
        : { aside: a, placement: { top: 40, left: Math.max(0, 760 - w), width: w, maxHeight: 440, side: "below" } },
  });
}
flushSync();
setTimeout(() => {
  const r = (sel: string) => {
    const e = document.querySelector(sel);
    if (!e) return "absent";
    const b = e.getBoundingClientRect();
    return `${Math.round(b.left)}..${Math.round(b.right)} x ${Math.round(b.top)}..${Math.round(b.bottom)} (h ${Math.round(b.height)})`;
  };
  cap.textContent =
    `${v} w=${w} vw=${innerWidth} asking=${asking}\n` +
    `body ${r(".aside-card-body")} · head ${r(".aside-card-head, .aside-view-head")} · cache ${r(".aside-cache")}\n` +
    `caption ${r(".aside-line")} · format ${r(".bottom-toggle")} · composer card ${r(".composer .card")} · turns ${r(".aside-view-turns")} · of ${r(".aside-card-of, .aside-view-of")}`;
}, 500);
