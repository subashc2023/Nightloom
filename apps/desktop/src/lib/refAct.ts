/*
 * What a click in a typed link's card does (nightshift item 993d) — the `act` `App.svelte` hands `RefCardHost`.
 *
 * Three actions never leave the Mac and ask nothing: open the item's own page in the browser, open it in a tab
 * here, copy its link. The link is the tag's own, kept only when it is https on a Google host (`refTag.ts`).
 *
 * The rest reach a connector — an answer to an invitation, a reply saved as a Gmail draft, and (993e) a reply or a
 * forward sent — and go through the one command that can (`api.refAct`): one call, let through once by a pass
 * minted for exactly it. This module is called only from the card's confirm button and the Undo he clicks; a
 * reply being drawn, a model's turn and a link being opened call nothing here (blocker 2304; the test pins it).
 *
 * What comes back is the connector's own answer: done (the stamp), not there any more (`gone`: the card says so,
 * the link dims), or an error — thrown, so the card keeps his words and shows the reason.
 */
import type { Ref } from "./refTag";
import { RSVP_CHOICES, type RefAction, type RefReceipt } from "./refCard";
import type { RefActItem, RefActReceipt, RefHeads } from "./api";
import { MaybeSent } from "./mailHold";

export interface RefActDeps {
  /** The item's page in his browser. */
  openUrl: (url: string) => Promise<unknown>;
  /** The item's page in a tab here. */
  openTab: (url: string) => Promise<unknown>;
  copy: (text: string) => Promise<unknown>;
  /** The one command that reaches a connector. */
  run: (item: RefActItem, act: Extract<RefAction, { type: "rsvp" | "saveDraft" | "send" }>, binary?: string, safeMode?: boolean) => Promise<RefActReceipt>;
  /** The read-only read of an email's headers (993e review, finding 1). */
  read?: (item: RefActItem, binary?: string, safeMode?: boolean) => Promise<RefHeads>;
  /** The rail's Claude Code binary and safe mode, as every one-shot turn takes them. */
  agent?: () => { binary?: string; safeMode?: boolean };
}

const shortLink = (url: string) => {
  const s = url.replace(/^https:\/\//, "");
  return s.length > 44 ? `${s.slice(0, 43)}…` : s;
};

export function itemOf(ref: Ref): RefActItem {
  return { kind: ref.kind, id: ref.id, src: ref.src, cal: ref.fields.cal, name: ref.name };
}

export function makeRefAct(d: RefActDeps): (ref: Ref, a: RefAction) => Promise<RefReceipt> {
  return async (ref, a) => {
    if (a.type === "open" || a.type === "readHere" || a.type === "copyLink") {
      const link = ref.fields.link;
      if (!link) throw new Error("this link came without its address");
      if (a.type === "copyLink") {
        await d.copy(link);
        return { stamp: "Copied", text: shortLink(link) };
      }
      if (a.type === "readHere") {
        await d.openTab(link);
        return { stamp: "Opened", text: "in a tab here" };
      }
      await d.openUrl(link);
      return { stamp: "Opened", text: "in your browser" };
    }
    const agent = d.agent?.() ?? {};
    const r = await d.run(itemOf(ref), a, agent.binary, agent.safeMode);
    if (r.outcome === "not_found") return { stamp: "Gone", text: r.text, gone: true };
    if (r.outcome === "unknown") throw new MaybeSent(r.text);
    if (r.outcome !== "done") throw new Error(r.text);
    if (a.type === "rsvp") return { stamp: "Sent", text: `${RSVP_CHOICES.find((c) => c.answer === a.answer)?.done ?? r.text} · ${ref.name}`, rsvp: a.answer };
    if (a.type === "saveDraft") return { stamp: "Saved", text: r.text };
    // A mail (993e): the service's receipt names the addresses the call carried (read from the message, or his
    // typed forward address — never the tag's), then the subject as the message itself gave it.
    const about = a.type === "send" ? (a.about ?? ref.name) : ref.name;
    return { stamp: "Sent", text: about ? `${r.text} · ${about}` : r.text };
  };
}

/** The card's read of an email's own headers, on the rail's binary and safe mode. */
export function makeRefRead(d: RefActDeps): ((ref: Ref) => Promise<RefHeads>) | undefined {
  const read = d.read;
  if (!read) return undefined;
  return (ref) => {
    const agent = d.agent?.() ?? {};
    return read(itemOf(ref), agent.binary, agent.safeMode);
  };
}
