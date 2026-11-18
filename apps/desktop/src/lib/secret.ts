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

// ---- item 766 part 2: "From Bitwarden" ---------------------------------------
// He picks a vault item and a field; the host reads the one value through
// `bw` into the same private file (`bitwarden_store` on the Mac,
// `POST /api/bitwarden/store` from the phone). The card gets names and
// field names only, never a value.

/** `bitwarden::Ready`: whether the host can read from Bitwarden. */
export type BwReady = "missing" | "unauthenticated" | "locked" | "unlocked";

/** One vault item as the card lists it (`bitwarden::ItemView`). */
export interface BwItem {
  id: string;
  name: string;
  host: string | null;
  /** `password`, `username`, `notes`, or `field:<name>`. */
  fields: string[];
}

/** What the card asks the host for; the Mac and the phone each give one. */
export interface BwApi {
  ready(): Promise<BwReady>;
  /** The key `bw unlock --raw` printed (the Mac only). */
  useSession?(key: string): Promise<BwReady>;
  search(query: string): Promise<BwItem[]>;
  /** Read the value into the chat's private file; `alwaysFor` keeps the rule. */
  store(itemId: string, field: string, alwaysFor: string | null): Promise<void>;
}

/** The command the model said it will run with the secret, if any. */
export function secretCommand(input: unknown): string | null {
  const c = (input ?? {}) as { command?: unknown };
  return typeof c.command === "string" && c.command.trim() ? c.command.trim() : null;
}

/**
 * The command's first plain words, as "always" keeps them — the same rule as
 * `bitwarden::command_prefix`: the program, then words up to the first flag,
 * quote, variable, path or operator, at most three.
 */
export function commandPrefix(command: string | null): string | null {
  if (!command) return null;
  const words: string[] = [];
  const plain = /^[A-Za-z0-9._+:@-]+$/;
  for (const [i, w] of command.trim().split(/\s+/).entries()) {
    const ok = i === 0 ? /^[A-Za-z0-9._+:@/-]+$/.test(w) : !w.startsWith("-") && plain.test(w);
    if (!ok || words.length === 3 || w.includes("=")) break;
    words.push(w);
  }
  return words.length ? words.join(" ") : null;
}

/** The search the card starts with: GITHUB_TOKEN → "github". */
export function defaultQuery(name: string): string {
  const first = name.split("_").find((w) => w.length > 1) ?? name;
  return /^[A-Z0-9]+$/i.test(first) ? first.toLowerCase() : "";
}

/** A field's short name on the card's chips. */
export function fieldChip(field: string): string {
  return field.startsWith("field:") ? field.slice(6) : field;
}

/** The field the card picks first: the password, else a custom field. */
export function firstField(item: BwItem): string | null {
  if (item.fields.includes("password")) return "password";
  return item.fields.find((f) => f.startsWith("field:")) ?? item.fields[0] ?? null;
}

/** The one line a card shows when it cannot read from Bitwarden: which, and what he does. */
export function bwNotReady(ready: BwReady, where: "mac" | "phone"): string | null {
  switch (ready) {
    case "missing":
      return "Bitwarden's command line is not installed. In Terminal: brew install bitwarden-cli";
    case "unauthenticated":
      return "Bitwarden is signed out. In Terminal: bw login";
    case "locked":
      return where === "mac"
        ? "Bitwarden is locked. In Terminal: bw unlock --raw — then paste the key it prints below."
        : "Bitwarden is locked on the computer. Unlock it on the Mac's card (bw unlock --raw in Terminal).";
    default:
      return null;
  }
}

/** The two Bitwarden buttons' tips (two short lines at most). */
export const BW_ONCE_TIP = "Reads it for this card only.\nClaude sees only where it is.";
export const BW_ALWAYS_TIP = "This item, for this command, without asking.\nRemove it in Settings → Bitwarden.";
export const BW_NO_COMMAND_TIP = "Claude named no command,\nso there is nothing to allow it for.";

/** Where the pasted session key goes. */
export const BW_KEY_WHERE = "Kept in Nightloom's memory only, forgotten after 30 idle minutes or at quit.";
