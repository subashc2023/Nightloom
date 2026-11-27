/*
 * The phone's hands for the typed link's card (nightshift item 993f): `refAct.ts`'s rule, with every connector
 * action run on the Mac through the listener (`/home/ref/*`, `ref_routes.rs`).
 *
 * **The phone's tap is his click.** Each connector action takes the Mac's one-time tap for exactly it first
 * (`refTap`), then lets it go (`refAct`): an RSVP or a saved draft at once, a mail only when its 5 s hold on the
 * phone ends (RefCardHost's `armSend` minted the tap at the start of the hold). The Mac runs only the call a tap
 * was minted for, once, through 993d/993e's own pass and guard. Nothing here retries: a request whose answer never
 * came back is "may have gone" for a mail (Send stays off until he checked), "may or may not" for the rest.
 *
 * **The tap is signed by this phone** (item 993g): the paired token is shared and kept on the Mac, so the Mac mints
 * a tap only for a phone he allowed there (`key`, this phone's key id) and lets it go only with this phone's
 * signature over the tap and the Mac's challenge for it (`phoneKey.ts`). The signature is made when the tap is let
 * go: for a mail, after its hold.
 *
 * Opening and copying the link never leave the phone.
 */
import type { Ref } from "../lib/refTag";
import { refKey } from "../lib/refTag";
import type { RefAction } from "../lib/refCard";
import type { RefActItem } from "../lib/api";
import { itemOf, makeRefAct, makeRefRead, type RefActDeps } from "../lib/refAct";
import { MaybeSent } from "../lib/mailHold";
import { ApiError, Unreachable, type Client, type RefWireAct } from "./client";
import { tapMessage, type PhoneSigner } from "./phoneKey";

export const NO_MAC = "Your Mac is not paired with this phone, so nothing can be sent from here.";
export const LOST_AS_SENT = "Your phone lost your Mac as the mail was let go. It may have gone: check Sent in Gmail before sending again.";
export const LOST_AS_ACTED = "Your phone lost your Mac as this was let go, so it may or may not have gone through. Open it to check.";

type Wire = Extract<RefAction, { type: "rsvp" | "saveDraft" | "send" }>;

/** The action as the listener takes it: his tap rides beside it, never inside. */
export function wireOf(a: Wire): RefWireAct {
  const { tap: _tap, ...rest } = a as Wire & { tap?: string };
  return rest as RefWireAct;
}

const said = (e: unknown) => (e instanceof ApiError ? e.message || `the Mac answered ${e.status}` : String(e instanceof Error ? e.message : e));

export const NO_KEY = "This phone is not allowed to send yet, so nothing was sent.";

/** This phone's key for a tap: the signer and the id the Mac knows it by (null until he allowed it there). */
export interface PhoneTapKey {
  signer: PhoneSigner;
  id: () => string | null;
  /** The Mac refused this phone's key (removed there): look again. */
  refused?: () => void;
}

export function phoneRefDeps(mac: () => Client | null, key: PhoneTapKey, challenges: Map<string, string> = new Map()): RefActDeps {
  const need = () => {
    const c = mac();
    if (!c) throw new Error(NO_MAC);
    return c;
  };
  /** The let-go: this phone's signature over the tap and its challenge, then the one request. */
  const letGo = async (c: Client, tap: string, item: RefActItem, wire: RefWireAct, mail: boolean) => {
    const challenge = challenges.get(tap);
    challenges.delete(tap);
    if (challenge === undefined) throw new Error("This tap has no challenge from your Mac behind it, so nothing was sent.");
    let sig: string;
    try {
      sig = await key.signer.sign(tapMessage(tap, challenge));
    } catch (e) {
      // Nothing left the phone; the tap is dropped on the Mac.
      void c.refUndo(tap).catch(() => {});
      throw new Error(`This phone could not sign your tap, so nothing was sent (${e instanceof Error ? e.message : String(e)}).`);
    }
    try {
      return await c.refAct(tap, item, wire, sig);
    } catch (e) {
      if (e instanceof Unreachable) throw mail ? new MaybeSent(LOST_AS_SENT) : new Error(LOST_AS_ACTED);
      if (e instanceof ApiError && e.status === 403) key.refused?.();
      throw new Error(said(e));
    }
  };
  return {
    openUrl: async (url) => void window.open(url, "_blank", "noopener"),
    openTab: async (url) => void window.open(url, "_blank", "noopener"),
    copy: (text) => navigator.clipboard.writeText(text),
    run: async (item: RefActItem, a: Wire) => {
      const c = need();
      const wire = wireOf(a);
      let tap: string;
      if (a.type === "send") {
        // A mail's tap was minted at the start of its hold; without one nothing goes.
        const t = (a as Wire & { tap?: string }).tap;
        if (!t) throw new Error("This mail has no tap of yours behind it, so nothing was sent.");
        tap = t;
      } else {
        const id = key.id();
        if (!id) throw new Error(NO_KEY);
        try {
          const t = await c.refTap(item, wire, id);
          challenges.set(t.tap, t.challenge);
          tap = t.tap;
        } catch (e) {
          if (e instanceof ApiError && e.status === 403) key.refused?.();
          throw new Error(e instanceof Unreachable ? "Your phone could not reach your Mac, so nothing was sent." : said(e));
        }
      }
      return letGo(c, tap, item, wire, a.type === "send");
    },
    read: async (item) => {
      try {
        return await need().refRead(item);
      } catch (e) {
        throw new Error(e instanceof Unreachable ? "your phone could not reach your Mac" : said(e));
      }
    },
  };
}

/** Everything RefCardHost takes from the phone. */
export function phoneRefCards(mac: () => Client | null, key: PhoneTapKey) {
  // The Mac's challenge for each live tap, until it is let go or dropped.
  const challenges = new Map<string, string>();
  const deps = phoneRefDeps(mac, key, challenges);
  return {
    act: makeRefAct(deps),
    readMail: makeRefRead(deps)!,
    armSend: async (ref: Ref, a: Extract<RefAction, { type: "send" }>) => {
      const c = mac();
      if (!c) throw new Error(NO_MAC);
      const id = key.id();
      if (!id) throw new Error(NO_KEY);
      try {
        const t = await c.refTap(itemOf(ref), wireOf(a), id);
        challenges.set(t.tap, t.challenge);
        return t;
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) key.refused?.();
        throw new Error(e instanceof Unreachable ? "Your phone could not reach your Mac, so nothing was sent." : said(e));
      }
    },
    disarm: (tap: string) => (challenges.delete(tap), void mac()?.refUndo(tap).catch(() => {})),
    lockOf: async (ref: Ref, mark?: string | null) => {
      const c = mac();
      if (!c) throw new Error(NO_MAC);
      return (await c.refLock(refKey(ref), mark)).maybe ?? null;
    },
    checked: (key: string) => void mac()?.refChecked(key).catch(() => {}),
    loadReach: async () => {
      const c = mac();
      if (!c) throw new Error(NO_MAC);
      return c.refReach();
    },
  };
}
