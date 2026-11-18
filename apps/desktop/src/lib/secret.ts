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

/**
 * Item 825: programs that run another command — "always" for one would be
 * "always" for every command. The same lists as `bitwarden::WRAPPERS` and
 * `bitwarden::INTERPRETERS`.
 */
export const WRAPPERS = [
  "bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "ash", "busybox", "env",
  "sudo", "doas", "su", "xargs", "eval", "exec", "command", "builtin", "nohup", "time", "nice",
  "ionice", "timeout", "gtimeout", "watch", "script", "parallel", "caffeinate", "stdbuf",
  "setsid", "chroot", "flock", "arch", "unbuffer", "expect", "launchctl", "osascript",
  // Review (merge round V).
  "sandbox-exec", "xcrun", "taskset", "chrt", "pkexec", "runuser", "unshare", "nsenter", "strace",
  "ltrace", "dtruss", "gdb", "lldb", "valgrind", "entr", "firejail", "bwrap", "proxychains",
  "proxychains4", "torsocks", "fakeroot", "faketime", "rlwrap", "ssh-agent", "systemd-run",
  "dbus-run-session",
];
/** Launchers of two or three words, refused alone (`bitwarden::LAUNCHERS`). */
export const LAUNCHERS = [
  "npm exec", "npm x", "pnpm exec", "pnpm dlx", "yarn exec", "yarn dlx", "bun x", "bun run",
  "deno run", "deno eval", "uv run", "uv tool", "uv tool run", "poetry run", "pipenv run", "pdm run", "hatch run",
  "rye run", "conda run", "mamba run", "micromamba run", "bundle exec", "mise exec", "mise x",
  "asdf exec", "nix run", "nix shell", "nix develop", "direnv exec", "go run",
];
export const INTERPRETERS = [
  "python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "deno", "bun", "perl",
  "ruby", "php", "lua", "luajit", "tclsh", "wish", "rscript", "awk", "gawk", "mawk", "nawk",
  "npx", "pnpx", "bunx", "uvx", "pipx", "jshell", "irb", "swift",
];

/** A program word's own name: `/usr/bin/python3.12` → `python3`. */
function programName(word: string): string {
  let base = (word.split("/").pop() ?? word).toLowerCase();
  const dot = base.indexOf(".");
  if (dot >= 0 && /^[0-9.]*$/.test(base.slice(dot + 1))) base = base.slice(0, dot);
  return base;
}

/**
 * Why "always" cannot be kept for `prefix`, in one short line, or null —
 * the same rule as `bitwarden::wrapper_refusal`.
 */
export function wrapperRefusal(prefix: string | null): string | null {
  if (!prefix) return null;
  const words = prefix.trim().split(/\s+/);
  const first = words[0];
  if (!first) return null;
  const name = programName(first);
  if (WRAPPERS.includes(name)) return `Not for \`${first}\`: it runs any command it is given.`;
  const interp = INTERPRETERS.includes(name) || INTERPRETERS.includes(name.replace(/[0-9]+$/, ""));
  if (interp && words.length === 1) return `Not for \`${first}\` alone: it runs any code it is given.`;
  if (words.length > 1 && LAUNCHERS.includes(`${name} ${words.slice(1).join(" ")}`))
    return `Not for \`${words.join(" ")}\` alone: it runs any code it is given.`;
  return null;
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
export const BW_ALWAYS_TIP = "This item, for this command, without asking.\nGiven only while that command runs.";
export const BW_NO_COMMAND_TIP = "Claude named no command,\nso there is nothing to allow it for.";

/** Where the pasted session key goes. */
export const BW_KEY_WHERE = "Kept in Nightloom's memory only, forgotten after 30 idle minutes or at quit.";
