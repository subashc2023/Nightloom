/**
 * Allow and Deny on the macOS needs-you banner (item 973, after Caprock's
 * notification — report 762): which banners offer them, and where a press
 * goes. Pure, so the suite pins the routing; `state.svelte.ts`'s
 * `answerFromBanner` carries a route out.
 *
 * Three rules, from the item's spec:
 * - a press answers the waiting call with exactly the banner's id, and no
 *   other — found on screen or in a background chat by that id alone;
 * - a banner whose call was answered already (on the card, the phone, the
 *   3:30 set-aside) does nothing, and says so;
 * - Allow is as deliberate as the card's: offered only when the banner
 *   shows the whole of what would run (`bannerAllows`), checked again at
 *   the press, and never the answer to a click, a clear or a time-out.
 *
 * One button per banner (coordinator's call, 2026-11-25): Allow on a
 * banner that shows the whole call (its Deny is on the card), else Deny.
 * The close button is "Later" and answers nothing — it is not known
 * whether clearing a banner reports as that button.
 */
import type { ApprovalRequest } from "./types";
import { isStuck } from "./stuck";

/** The banner's longest shown argument that still offers Allow: past it
 *  the banner would cut the call, and he would allow what he cannot read. */
export const BANNER_ALLOW_CHARS = 100;

type Req = Pick<ApprovalRequest, "id" | "name" | "input"> &
  Partial<Pick<ApprovalRequest, "kind" | "outside" | "aside">>;

/**
 * The whole of what the call would run, when the banner can show it and so
 * offer Allow; `null` when it cannot, and the banner offers Deny alone (a
 * click opens the card). A plain tool call only — not a question, a plan,
 * the runaway guard, an aside's card, a read-only chat's card (`kind`), a
 * call outside the chat's folders (`outside`: the card offers a grant) or
 * the model asking for a folder. Its input must carry one string, beside
 * Bash's own `description` label (the model's words, not what runs), on
 * one line and short enough to show whole; numbers and switches may ride
 * with it (a timeout), a nested object may not.
 */
export function bannerAllows(req: Req): string | null {
  if (req.name === "AskUserQuestion" || req.name === "ExitPlanMode" || isStuck(req.name)) return null;
  if (req.kind || req.outside || req.aside !== undefined) return null;
  if (req.name === "mcp__nightloom__add_folder") return null;
  const input = req.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  let shown: string | null = null;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "description") continue;
    if (typeof v === "string") {
      if (!v.trim()) continue;
      if (shown !== null) return null;
      shown = v;
    } else if (v !== null && typeof v === "object") {
      return null;
    }
  }
  if (shown === null) return null;
  const one = shown.trim();
  if (/[\r\n]/.test(one) || one.length > BANNER_ALLOW_CHARS) return null;
  return one;
}

/** The banner's two lines when it offers Allow: the call by name, and what
 *  it runs, whole. */
export function allowBannerBody(shown: string): string {
  return `${shown} · Allow here, or open the card to Deny`;
}

/** What the banner reported: a button, or a click on its body. */
export type BannerPress = "allow" | "deny" | "open";

export type BannerRoute =
  /** No call waits under that id: answered already, or set aside. */
  | { act: "stale" }
  /** A look: the window came forward and the card is there. */
  | { act: "open" }
  | {
      act: "answer";
      decision: "allow" | "deny";
      req: ApprovalRequest;
      /** `null`: the chat on screen; else the background chat's key. */
      background: string | null;
    };

/**
 * Where a press goes. The id is matched exactly against the calls waiting
 * on screen, then each background chat's; nothing else is consulted, so a
 * press can never reach another call. An Allow on a call whose banner could
 * not have offered it (were it to arrive) is a look, not an allow.
 */
export function routeBannerPress(
  id: string,
  press: BannerPress,
  screen: readonly ApprovalRequest[],
  background: Readonly<Record<string, { approvals: readonly ApprovalRequest[] }>>,
): BannerRoute {
  let req: ApprovalRequest | undefined = screen.find((r) => r.id === id);
  let where: string | null = null;
  if (!req) {
    for (const [key, b] of Object.entries(background)) {
      const r = b.approvals.find((x) => x.id === id);
      if (r) {
        req = r;
        where = key;
        break;
      }
    }
  }
  if (!req) return { act: "stale" };
  if (press === "open") return { act: "open" };
  if (press === "allow" && bannerAllows(req) === null) return { act: "open" };
  // A banner has one button (coordinator's call, 2026-11-25): Allow where
  // the banner shows the whole call, else Deny — so a Deny on an Allow
  // banner, or on a question, a plan or the guard, was never offered.
  if (
    press === "deny" &&
    (bannerAllows(req) !== null || req.name === "AskUserQuestion" || req.name === "ExitPlanMode" || isStuck(req.name))
  ) {
    return { act: "open" };
  }
  return { act: "answer", decision: press, req, background: where };
}

/** A clock time for him: 12-hour, "6:41 AM". */
export function bannerClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** What the chat (a toast) and a confirming banner say after a press. */
export function answeredLine(decision: "allow" | "deny", name: string, chat: string, at: number): string {
  return `${decision === "allow" ? "Allowed" : "Denied"} ${name} in ${chat} from the notification at ${bannerClock(at)}`;
}

/** What they say of a press on a banner whose call no longer waits. */
export function staleLine(name: string | null, chat: string | null): string {
  const what = name ? `${name}${chat ? ` in ${chat}` : ""}` : "That call";
  return `${what} was already answered, so the notification did nothing`;
}
