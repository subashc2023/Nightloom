/**
 * Prompt links (nightshift item 976, from 762's survey of T3 Code):
 * `nightloom://new?project=<name>&prompt=<text>` opens a new chat in that
 * project with the prompt in its message box — never sent. This is the
 * link's reading; where it goes is `promptLinks.svelte.ts`, and its arrival
 * is `prompt_links.rs`.
 *
 * Hidden characters are stripped from the prompt, with a notice: a link is
 * text from somewhere else, and a zero-width or direction-changing
 * character would put words in the box that he cannot see.
 */
import type { ProjectInfo } from "./types";

export interface PromptLink {
  /** The project named, as written; null when the link names none. */
  project: string | null;
  /** The prompt, hidden characters removed. */
  prompt: string;
  /** How many hidden characters were removed. */
  removed: number;
}

/**
 * Invisible format characters (Unicode category Cf: zero-width spaces and
 * joiners, direction marks and overrides, the BOM, tag characters), and
 * control characters other than tab and newline. A carriage return is
 * taken as a line end, not counted.
 */
const HIDDEN = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** `text` without its hidden characters, and how many there were. */
export function stripHidden(text: string): { text: string; removed: number } {
  const lines = text.replace(/\r\n?/g, "\n");
  let removed = 0;
  const out = lines.replace(HIDDEN, () => {
    removed += 1;
    return "";
  });
  return { text: out, removed };
}

/**
 * The link read, or null when it is not a `nightloom://new` link with a
 * prompt. `project` and `prompt` are the query's (percent- and
 * plus-decoded); anything else in it is ignored.
 */
export function parsePromptLink(raw: string): PromptLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "nightloom:") return null;
  // `nightloom://new?…` has the host `new`; `nightloom:new?…` its path.
  const what = (url.host || url.pathname.replace(/^\/+/, "")).replace(/\/+$/, "").toLowerCase();
  if (what !== "new") return null;
  const prompt = url.searchParams.get("prompt");
  if (prompt === null) return null;
  const { text, removed } = stripHidden(prompt);
  if (!text.trim()) return null;
  const named = stripHidden(url.searchParams.get("project") ?? "").text.trim();
  return { project: named || null, prompt: text, removed };
}

/** The project a link names: by id, else by name ignoring case. */
export function projectNamed(projects: readonly ProjectInfo[], named: string): ProjectInfo | null {
  const want = named.trim().toLowerCase();
  return projects.find((p) => p.id === named) ?? projects.find((p) => p.name.trim().toLowerCase() === want) ?? null;
}

/** The box's text with the prompt in it: alone, or after what he had typed in that new chat already (never over it). */
export function withPrompt(existing: string, prompt: string): string {
  return existing.trim() ? `${existing.replace(/\s+$/, "")}\n\n${prompt}` : prompt;
}

/** A link for `prompt` in `project` — what the morning page and a hand-off can print. */
export function promptLinkFor(prompt: string, project?: string | null): string {
  const q = new URLSearchParams();
  if (project) q.set("project", project);
  q.set("prompt", prompt);
  return `nightloom://new?${q.toString().replace(/\+/g, "%20")}`;
}
