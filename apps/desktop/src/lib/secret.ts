// The secret-request card (nightshift item 766): a chat that needs a token,
// a password or a key calls `request_secret`, and this card asks for it. The
// value goes to the host's private store first (`store_secret` on the Mac,
// `POST /api/secret` from the phone), then the card answers a bare Allow —
// so the value is never in an answer, a draft, localStorage or the chat.
// Pure: the words the Mac's card and the phone's card share.

/** The tool's name on the Claude Code engine (`secret::TOOL_NAME`). */
export const SECRET_TOOL = "mcp__nightloom__request_secret";

export function isSecretRequest(name: string): boolean {
  return name === SECRET_TOOL;
}

export interface SecretView {
  /** What the model calls it, as the backend will: GITHUB_TOKEN. */
  name: string;
  /** The model's one line: what it is for, where he finds it. */
  why: string | null;
}

/** The card's reading of the call's input. */
export function secretView(input: unknown): SecretView {
  const o = (input ?? {}) as { name?: unknown; why?: unknown };
  const name = typeof o.name === "string" ? o.name.trim().toUpperCase() : "";
  const why = typeof o.why === "string" && o.why.trim() ? o.why.trim() : null;
  return { name: name || "a secret", why };
}

/** The reason the model reads when he declines. */
export const SECRET_DECLINED =
  "The user did not enter it. Do not ask again in this reply unless they say to; carry on without it or say what you could not do.";

/** The card's one line on where the value goes. */
export const SECRET_WHERE = "Kept in a private file on this Mac for a day. Never in the chat, its record or search.";

/** The two buttons' tips (two short lines at most). */
export const USE_TIP = "Keeps it for this chat's commands.\nClaude sees only where it is.";
export const DECLINE_TIP = "Claude carries on without it.";

/** The phone card's line: the value is kept by the computer the chat runs on. */
export const SECRET_WHERE_PHONE =
  "Kept in a private file on the computer running this chat, for a day. Never in the chat, its record or search.";
