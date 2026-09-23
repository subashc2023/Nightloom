// Curated model catalog + user preferences for what the connection rail's
// dropdowns offer. Preferences persist in localStorage; the catalog itself
// is a starting point — the settings modal can hide entries or add custom
// model ids per provider.

/** Human-facing provider names ("openai-chat" is a wire format, not a brand). */
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-chat": "OpenAI-compatible",
  gemini: "Google Gemini",
  groq: "Groq",
  openrouter: "OpenRouter",
};

export function providerLabel(kind: string): string {
  return PROVIDER_LABELS[kind] ?? kind;
}

/** One-line description shown in the settings pane for each provider. */
export const PROVIDER_NOTES: Record<string, string> = {
  anthropic: "Claude models via the Anthropic Messages API.",
  openai: "GPT models via OpenAI's native Responses API.",
  "openai-chat":
    "Any server speaking the OpenAI chat/completions wire format — local " +
    "runtimes (Ollama, LM Studio, llama.cpp, vLLM) via a base URL, or " +
    "api.openai.com's legacy endpoint. Models are whatever the server hosts.",
  gemini: "Gemini models via Google's Generative Language API.",
  groq: "Open-weight models on Groq's LPU inference.",
  openrouter: "One key for hundreds of models across hosts, via OpenRouter.",
};

/** Known-good model ids per provider (verified via `nightloom probe`). */
export const CURATED: Record<string, string[]> = {
  anthropic: [
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-haiku-4-5",
  ],
  openai: ["gpt-5-mini", "gpt-5", "gpt-5-nano"],
  // openai-chat targets local servers / custom hosts: models are whatever
  // the server loads, so the catalog starts empty (add ids in settings).
  "openai-chat": [],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
  groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"],
  openrouter: [
    "openrouter/auto",
    "anthropic/claude-sonnet-5",
    "deepseek/deepseek-v4-flash",
    "x-ai/grok-4.3",
  ],
};

export interface CatalogPrefs {
  /** Provider kinds unchecked in settings (hidden from the rail dropdown). */
  hiddenProviders: string[];
  /** Curated models unchecked in settings, per provider kind. */
  hiddenModels: Record<string, string[]>;
  /** User-added model ids, per provider kind. */
  customModels: Record<string, string[]>;
}

/** Everything needed to (re)connect: the rail edits this, connect sends it. */
/**
 * Which engine a chat runs on.
 *
 * "provider" is an API key and Nightloom's own loop; "claude-code" drives the
 * signed-in CLI as a subprocess, so the turn is billed to a Claude
 * subscription instead. They are two engines behind one event stream rather
 * than a sixth provider under the first, because Claude Code owns the loop,
 * the tools and the history — there is no request here for Nightloom to make.
 */
export type Engine = "provider" | "claude-code";

/**
 * Model aliases the CLI accepts, in its own order, plus "" for whatever it
 * defaults to.
 *
 * Suggestions rather than a closed list, which is why the rail offers them
 * through a `datalist` and not a `select`: `--model` takes a full id
 * (`claude-fable-5`) as readily as an alias, the aliases themselves move with
 * the CLI's releases rather than with ours, and which ones a given account can
 * actually reach depends on its plan. A closed list can only be wrong in the
 * direction that matters — it silently withholds a model the user is paying
 * for, with nowhere to type it.
 */
export const AGENT_MODELS = ["", "fable", "opus", "sonnet", "haiku"];

/**
 * The four core models and the key each switches to, on any screen (⌘⇧ +
 * the letter; nightshift blocker 035, 2026-09-13). The aliases are the CLI's,
 * and on the provider engine a key picks the first id in the picker's list
 * that *contains* the alias — `claude-sonnet-5` on Anthropic,
 * `anthropic/claude-sonnet-5` on OpenRouter. A provider with no such id
 * makes the key do nothing, and the ⌘K row says so.
 */
export const MODEL_KEYS: { alias: string; key: string }[] = [
  { alias: "sonnet", key: "S" },
  { alias: "opus", key: "O" },
  { alias: "fable", key: "F" },
  { alias: "haiku", key: "H" },
];

/** The alias a model id carries, or null; the popover prints its key cap. */
export function aliasOf(id: string): string | null {
  const lower = id.toLowerCase();
  return MODEL_KEYS.find((k) => lower.includes(k.alias))?.alias ?? null;
}

/** The first id in `models` that carries `alias`, or null. */
export function modelForAlias(models: string[], alias: string): string | null {
  return models.find((m) => m.toLowerCase().includes(alias)) ?? null;
}

/**
 * The file a model's own instructions live in, under `~/.nightloom/models/`:
 * the id plus `.md`, with a `/` — which router ids carry
 * (`deepseek/deepseek-v4-flash`) — written `__`, so the id is one file in
 * one folder. A `:` is left alone. The same rule as the backend's
 * `prompt::model_instruction_file`, spelled here as well because the picker
 * needs the name synchronously to say which file its pencil opens.
 */
export function modelInstructionFile(id: string): string {
  return `${id.trim().replace(/\//g, "__")}.md`;
}

/** The inverse, for listing the folder: `deepseek__deepseek-v4-flash.md` →
 *  `deepseek/deepseek-v4-flash`. A name without `.md` is shown as it is. */
export function modelOfInstructionFile(name: string): string {
  return name.replace(/\.md$/, "").replace(/__/g, "/");
}

/**
 * What Settings' any-model picker writes when it creates a file for a
 * provider/model pair (nightshift backlog 053): the name is
 * `modelInstructionFile` and nothing else — the preamble keys the file on
 * the model id alone, and a second mapping here would be a file the chat
 * never reads — and the content is one comment line naming the pair, so a
 * file found in the folder months later says what it was for. The provider
 * lives in that line only. On the Claude Code engine `provider` is
 * `"claude-code"` and `model` the alias the picker sends, since that is the
 * name the bridge looks up.
 */
export function instructionFileFor(
  provider: string,
  model: string,
): { name: string; header: string } {
  return {
    name: modelInstructionFile(model),
    header: `<!-- model instructions · ${provider} / ${model.trim()} -->\n`,
  };
}

/** `200000` → `200k`, `1048576` → `1M`; the context window beside a model id. */
export function formatWindow(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(1))}M`;
  return `${Math.round(n / 1_000)}k`;
}

export interface ConnectionDraft {
  /** Which engine the rail is on. Absent on drafts saved before it existed,
   *  which read as "provider" — the only engine there was. */
  engine: Engine;
  /** The CLI to run on the agent engine. Empty means `claude` on PATH. */
  agentBinary: string;
  /** A model alias or full id for the agent engine. Kept apart from `model`
   *  so switching engines does not hand one a model id the other cannot
   *  resolve, and switching back finds what you last chose. */
  agentModel: string;
  /** Run the agent without the host's CLAUDE.md, hooks, plugins and MCP. */
  agentSafeMode: boolean;
  /** The Ask position of the approval switch on the agent engine: the CLI
   *  pauses on each call a person should decide and the transcript asks
   *  (2026-09-16). Only meaningful with `approval` on. */
  agentAsk: boolean;
  /** The Plan position (2026-09-16, backlog 085): Ask under the CLI's plan
   *  mode — nothing is edited until the plan on the card is approved, and
   *  Approve picks Ask or Auto for the rest of the chat. Implies `agentAsk`;
   *  only meaningful with `approval` on. */
  agentPlan: boolean;
  /** *Subagents run on auto* (backlog 152, 2026-09-17): under Ask or
   *  Plan, a subagent's calls run without a prompt — the CLI drops a
   *  pause from that depth, so the only other position is a refusal in
   *  words. On by default (blocker 247); only meaningful with `agentAsk`. */
  agentSubagentsAuto: boolean;
  /** `--effort` on the agent engine (backlog 076): `low`, `medium`, `high`,
   *  `xhigh` or `max`, sent as spelled — or empty, the rail's *default*
   *  position, which sends no flag and leaves the level to the CLI. Empty
   *  by default (the whole-project review of 2026-09-16, F15: ~~`high` by
   *  default, which is what his settings say and what the model defaults
   *  to~~ meant every chat's command line gained `--effort high`, and a
   *  rail saved before the segment existed read back as a choice he never
   *  made). */
  agentEffort: string;
  /** `--fallback-model`: an alias the CLI retries with when the model is
   *  overloaded; empty is none. */
  agentFallback: string;
  /** Stop a turn once the CLI's own estimate passes this many dollars. 0 is
   *  no cap, which is the default: under a subscription the estimate is not
   *  a bill, and a cap on it stops turns for no saving. It is also the
   *  CLI's own budget limit on subagents (backlog 165): past it new agents
   *  cannot start. */
  agentBudget: number;
  /** The subagent limits (nightshift backlog 165): per turn (Nightloom's
   *  hook), at once and nesting depth (the CLI's own, passed as
   *  environment), per chat per day (the hook), and the usage-aware pair —
   *  at `slowAt` percent of the five-hour window the per-turn cap drops to
   *  `slowTo`, at `stopAt` every spawn is refused with the reset time. */
  agentLimits: SubagentLimits;
  provider: string;
  model: string;
  baseUrl: string;
  /** "default" | "effort-low" | "effort-medium" | "effort-high" | "budget" */
  thinkingMode: string;
  budget: number;
  system: string;
  tools: boolean;
  /** Assemble the built-in preamble (identity, environment, project files). */
  preamble: boolean;
  /** Attach the per-turn status block (time, tasks, context). */
  sidecar: boolean;
  /** Ask before running a tool that can change files or run commands. */
  approval: boolean;
  /**
   * Offer the web tools. Separate from `tools` because the questions are
   * different: a folder you are happy to let a model edit is not
   * automatically one you are happy to have quoted into a third party's
   * query log.
   */
  web: boolean;
  /**
   * Offer `compact_context`, letting the model ask for its own history to be
   * summarised at the end of a turn. Off by default and a knob of its own
   * rather than riding on `tools`: it is the one tool whose effect is on the
   * conversation instead of on the workspace, and a summary that replaces an
   * afternoon of context is not something to hand over without being asked.
   */
  selfCompact: boolean;
  /**
   * Give the model the knowledge base: the `@kb` tree and its index in the
   * preamble.
   *
   * On by default — the vault is only worth having if it is there — but a
   * knob of its own rather than riding on `tools`, because turning tools on
   * has always meant "may write inside this folder" and the vault is a second
   * directory outside it. A change in what the model can reach belongs on
   * screen.
   */
  knowledge: boolean;
  /**
   * Folder the file tools are rooted at, and where the preamble looks for
   * project instructions. Empty means "whatever the app was launched from",
   * which is rarely what anyone wants — the rail shows what it resolved to.
   */
  workspace: string;
  /**
   * The saved prompt `system` came from, or null for one-off text. Held as
   * an id rather than a name so renaming a prompt does not orphan the draft
   * pointing at it, and kept on the draft so the rail can show which one is
   * in use after a relaunch.
   */
  promptId: string | null;
}

export function defaultDraft(): ConnectionDraft {
  return {
    engine: "provider",
    agentBinary: "",
    agentModel: "",
    agentSafeMode: false,
    agentAsk: false,
    agentPlan: false,
    agentSubagentsAuto: true,
    agentEffort: "",
    agentFallback: "",
    agentBudget: 0,
    agentLimits: { ...DEFAULT_LIMITS },
    provider: "anthropic",
    model: "",
    baseUrl: "",
    thinkingMode: "default",
    budget: 8192,
    system: "",
    tools: false,
    preamble: true,
    sidecar: true,
    approval: true,
    web: true,
    selfCompact: false,
    knowledge: true,
    workspace: "",
    promptId: null,
  };
}

/** A named system prompt the user keeps around and reuses across chats. */
export interface SavedPrompt {
  id: string;
  name: string;
  text: string;
  /** Epoch ms of the last write, newest first in the library. */
  updated: number;
}

export interface ThinkingSupport {
  /** thinkingMode values the target accepts, in display order. */
  choices: { value: string; label: string }[];
  /** One-line explanation of how thinking behaves on this target. */
  note: string;
}

const DEFAULT_CHOICE = { value: "default", label: "default" };
const BUDGET_CHOICE = { value: "budget", label: "budget…" };
const effortChoices = (levels: string[]) =>
  levels.map((l) => ({ value: `effort-${l}`, label: `effort: ${l}` }));

/**
 * What the rail's thinking dropdown should offer for a (provider, model)
 * pair. Mirrors what each adapter actually maps (the adapters still fail
 * loudly on unsupported specs — this is the UI-side projection of that).
 */
export function thinkingSupport(kind: string, model: string): ThinkingSupport {
  switch (kind) {
    case "anthropic":
      // Claude 5 family (claude-<name>-5[-date]) thinks adaptively and
      // rejects token budgets; older ids (claude-haiku-4-5, claude-3-5-*)
      // take budget-style thinking and no effort knob.
      if (/^claude-[a-z]+-5($|-)/.test(model)) {
        return {
          choices: [DEFAULT_CHOICE, ...effortChoices(["low", "medium", "high"])],
          note:
            "Claude 5 thinks adaptively — effort steers how much, and the " +
            "model may skip thinking on easy prompts. Token budgets are " +
            "rejected by this family.",
        };
      }
      return {
        choices: [DEFAULT_CHOICE, BUDGET_CHOICE],
        note:
          "Claude ≤4.5 needs an explicit thinking-token budget (below max " +
          "output tokens); default leaves thinking off.",
      };
    case "openai":
      return {
        choices: [
          DEFAULT_CHOICE,
          ...effortChoices(["minimal", "low", "medium", "high"]),
        ],
        note:
          "Reasoning effort for gpt-5 models; the stream carries reasoning " +
          "summaries, not raw chain-of-thought. Budgets are not supported.",
      };
    case "gemini":
      if (/(^|-)gemini-3/.test(model)) {
        return {
          choices: [DEFAULT_CHOICE, ...effortChoices(["low", "high"])],
          note: "Gemini 3 takes a thinking level (low | high) instead of a token budget.",
        };
      }
      return {
        choices: [DEFAULT_CHOICE, BUDGET_CHOICE],
        note:
          "Gemini 2.5 thinks by default (summaries streamed); a budget caps " +
          "thinking tokens.",
      };
    case "openrouter":
      return {
        choices: [
          DEFAULT_CHOICE,
          ...effortChoices(["low", "medium", "high"]),
          BUDGET_CHOICE,
        ],
        note:
          "Effort or a token budget — OpenRouter normalizes either to " +
          "whatever the upstream model supports.",
      };
    case "groq":
      return {
        choices: [DEFAULT_CHOICE, ...effortChoices(["low", "medium", "high"])],
        note:
          "Reasoning effort for gpt-oss models; hybrid reasoners (qwen) " +
          "think regardless, with reasoning streamed either way.",
      };
    default: // openai-chat and anything unknown
      return {
        choices: [DEFAULT_CHOICE, ...effortChoices(["low", "medium", "high"])],
        note: "Sent as reasoning_effort — support depends on the server and model.",
      };
  }
}

/** Coerce a draft's thinking mode to one its (provider, model) accepts. */
export function sanitizeThinking(d: ConnectionDraft): void {
  const support = thinkingSupport(d.provider, d.model);
  if (!support.choices.some((c) => c.value === d.thinkingMode)) {
    d.thinkingMode = "default";
  }
}

/** The thinking-spec string the backend parses (`Thinking::FromStr`). */
export function thinkingString(d: ConnectionDraft): string {
  if (d.thinkingMode === "budget") {
    return `budget=${Math.max(1, Math.floor(d.budget))}`;
  }
  if (d.thinkingMode.startsWith("effort-")) {
    return `effort=${d.thinkingMode.slice(7)}`;
  }
  return "default";
}

/** Dropdown contents for one provider: curated minus hidden, plus custom. */
export function modelsFor(
  kind: string,
  prefs: CatalogPrefs,
  defaultModel: string | null,
): string[] {
  const hidden = new Set(prefs.hiddenModels[kind] ?? []);
  const models = (CURATED[kind] ?? []).filter((m) => !hidden.has(m));
  for (const m of prefs.customModels[kind] ?? []) {
    if (!models.includes(m)) models.push(m);
  }
  if (defaultModel && !models.includes(defaultModel) && !hidden.has(defaultModel)) {
    models.unshift(defaultModel);
  }
  return models;
}

export function isProviderVisible(kind: string, prefs: CatalogPrefs): boolean {
  return !prefs.hiddenProviders.includes(kind);
}

// ---- model list shaping (folding dated snapshots, grouping by family) ----
//
// A fetched provider list is a flat wall of ids in whatever order the vendor
// returned them, and most of its length is the same handful of models wearing
// different release dates. Two passes make it readable, and both are
// *presentation*: nothing here rewrites a preference or invents an id, so the
// rail still offers exactly the strings the user turned on.

/**
 * A trailing release tag: a date in any of the shapes vendors ship, a `-latest`
 * alias, or a Vertex-style `-001` revision.
 *
 * Deliberately narrow. Two digits (`gpt-4`, `grok-3`) and anything carrying a
 * letter (`gpt-oss-120b`, `llama-3.1-405b`) are parameter counts and version
 * numbers, not dates, and folding those away would merge models that are
 * genuinely different. The revision arm requires a leading zero for the same
 * reason — `-002` is a revision, `-405` is a size.
 */
const RELEASE_TAG =
  /[-@](?:latest|\d{4}-\d{2}-\d{2}|\d{2}-\d{4}|\d{2}-\d{2}|\d{8}|\d{6}|\d{4}|0\d{2})$/;

/** The id with its release tag removed, or the id unchanged when it has none. */
function foldBase(id: string): string {
  const m = RELEASE_TAG.exec(id);
  if (!m) return id;
  const base = id.slice(0, m.index);
  // Never fold a name away entirely: an id that is *only* a tag after its
  // vendor path (`some-vendor/2024-08-06`) has no base to fold into.
  return /[a-z]/i.test(base.slice(base.lastIndexOf("/") + 1)) ? base : id;
}

/** Sort key for a snapshot within its fold group: digits only, newest last. */
function releaseKey(id: string, base: string): string {
  const tag = id.slice(base.length + 1);
  if (tag === "latest") return "￿";
  return tag.replace(/\D/g, "").padEnd(8, "0");
}

/**
 * One offerable model plus the dated snapshots that collapsed into it.
 *
 * `id` is always a string the provider actually listed — untagged if there is
 * one, else `-latest`, else the newest snapshot. It is never synthesized: a
 * family whose only ids carry dates has no untagged form, and offering one
 * would be a 404 the user finds out about a turn later.
 */
export interface ModelEntry {
  id: string;
  /** Superseded ids, newest first. Hidden until asked for. */
  folded: string[];
}

/** A run of entries sharing a prefix. `name` is "" when they share nothing. */
export interface ModelSection {
  name: string;
  entries: ModelEntry[];
}

/**
 * Split an id into grouping tokens. A vendor path is one token (keeping its
 * slash, so it re-joins correctly), and the rest splits on `-`: `-` is the
 * separator every vendor uses between family, size and variant, which is what
 * makes a token trie find real families where a character-wise common prefix
 * would not — `gpt-5` and `gpt-oss` share four characters and nothing else.
 */
function idTokens(id: string): string[] {
  const slash = id.lastIndexOf("/");
  const rest = slash >= 0 ? id.slice(slash + 1) : id;
  const head = slash >= 0 ? [id.slice(0, slash + 1)] : [];
  return [...head, ...rest.split("-").filter(Boolean)];
}

function joinTokens(toks: string[]): string {
  return toks.reduce(
    (acc, t) => (acc === "" || acc.endsWith("/") ? acc + t : `${acc}-${t}`),
    "",
  );
}

/**
 * Above this many entries a group is split at its next branching token.
 * Below it, the group is left whole: a heading over three chips is noise, and
 * splitting `claude-sonnet-5 / claude-opus-5 / claude-haiku-4-5` by family
 * would put every model under a heading of its own.
 */
const FLAT_MAX = 12;

interface Grouped extends ModelEntry {
  tokens: string[];
  order: number;
}

/** A section mid-build, still carrying the ordering keys. */
interface Built {
  name: string;
  entries: Grouped[];
}

/**
 * Advance past the tokens every entry shares, then either emit the group whole
 * or fan it out one level and recurse. Recursion re-checks `FLAT_MAX`, so depth
 * follows how crowded a branch actually is — OpenRouter's three hundred ids
 * split by vendor and then again inside whichever vendor is large, while a
 * six-model provider stays one list.
 */
function partition(entries: Grouped[], depth: number, out: Built[]): void {
  let d = depth;
  for (;;) {
    const tok = entries[0].tokens[d];
    if (tok === undefined || !entries.every((e) => e.tokens[d] === tok)) break;
    d++;
  }
  const name = joinTokens(entries[0].tokens.slice(0, d));
  if (entries.length <= FLAT_MAX) {
    out.push({ name, entries });
    return;
  }
  const buckets = new Map<string, Grouped[]>();
  const here: Grouped[] = [];
  for (const e of entries) {
    const tok = e.tokens[d];
    if (tok === undefined) here.push(e);
    else (buckets.get(tok) ?? buckets.set(tok, []).get(tok)!).push(e);
  }
  if (buckets.size <= 1) {
    out.push({ name, entries });
    return;
  }
  // Entries that end exactly here (`gpt-5` beside `gpt-5-mini`) are their own
  // section rather than being pushed into an arbitrary sibling.
  if (here.length) out.push({ name, entries: here });
  for (const bucket of buckets.values()) partition(bucket, d + 1, out);
}

/**
 * Fold dated snapshots and group what is left into families.
 *
 * Input order is respected throughout — curated ids come first in the list the
 * settings pane assembles, and they stay first here — so the sections a user
 * sees on a provider they have never fetched are the hand-picked ones in the
 * order they were picked.
 */
export function groupModels(ids: string[]): ModelSection[] {
  const folds = new Map<string, string[]>();
  for (const id of ids) {
    const base = foldBase(id);
    (folds.get(base) ?? folds.set(base, []).get(base)!).push(id);
  }

  const entries: Grouped[] = [];
  let order = 0;
  for (const [base, variants] of folds) {
    let canonical = variants.find((v) => v === base);
    if (!canonical) {
      const ranked = [...variants].sort((a, b) =>
        releaseKey(b, base).localeCompare(releaseKey(a, base)),
      );
      canonical = ranked[0];
    }
    const folded = variants
      .filter((v) => v !== canonical)
      .sort((a, b) => releaseKey(b, base).localeCompare(releaseKey(a, base)));
    entries.push({
      id: canonical,
      folded,
      tokens: idTokens(canonical),
      order: order++,
    });
  }
  if (entries.length === 0) return [];

  const built: Built[] = [];
  partition(entries, 0, built);
  built.sort((a, b) => a.entries[0].order - b.entries[0].order);
  for (const s of built) s.entries.sort((a, b) => a.order - b.order);

  // A vendor that contributed one model gets a heading identical to the chip
  // under it. Rather than repeat every such id twice, they collect into one
  // unheaded block at the end — the ids are self-describing, and a column of
  // one-line sections is what makes a fetched list unreadable in the first
  // place.
  const out: ModelSection[] = [];
  const strays: Grouped[] = [];
  for (const s of built) {
    if (s.entries.length === 1 && s.name === s.entries[0].id) strays.push(s.entries[0]);
    else out.push({ name: s.name.replace(/\/$/, ""), entries: s.entries });
  }
  if (strays.length) out.push({ name: "", entries: strays });
  // A lone section's heading only restates the list under it.
  if (out.length === 1) out[0].name = "";
  return out.map((s) => ({
    name: s.name,
    entries: s.entries.map((e) => ({ id: e.id, folded: e.folded })),
  }));
}

// ---- persistence ----

const PREFS_KEY = "nightloom.catalog-prefs";
const LAST_KEY = "nightloom.last-connection";
const PROMPTS_KEY = "nightloom.prompts";

/**
 * Saved system prompts, newest-written first.
 *
 * These live with the app rather than in a project's `.nightloom/notes`,
 * because a system prompt is about how you want the model to behave and not
 * about a folder — and because an unfiled chat, which is the quickest thing
 * this app does, has no folder to read one out of. Anything that *is* about
 * the project belongs in the docspace, which the preamble already indexes.
 */
export function loadPrompts(): SavedPrompt[] {
  try {
    const raw = localStorage.getItem(PROMPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is SavedPrompt =>
          !!p && typeof p.id === "string" && typeof p.text === "string",
      )
      .map((p) => ({
        id: p.id,
        name: typeof p.name === "string" && p.name ? p.name : "Untitled",
        text: p.text,
        updated: typeof p.updated === "number" ? p.updated : 0,
      }));
  } catch {
    return [];
  }
}

export function savePrompts(list: SavedPrompt[]): void {
  try {
    localStorage.setItem(PROMPTS_KEY, JSON.stringify(list));
  } catch {
    // best-effort, like every other preference here
  }
}

/** Ids only have to be unique within one browser profile's library. */
export function newPromptId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function loadPrefs(): CatalogPrefs {
  const fallback: CatalogPrefs = {
    hiddenProviders: [],
    hiddenModels: {},
    customModels: {},
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<CatalogPrefs>;
    return {
      hiddenProviders: Array.isArray(parsed.hiddenProviders)
        ? parsed.hiddenProviders
        : [],
      hiddenModels:
        parsed.hiddenModels && typeof parsed.hiddenModels === "object"
          ? parsed.hiddenModels
          : {},
      customModels:
        parsed.customModels && typeof parsed.customModels === "object"
          ? parsed.customModels
          : {},
    };
  } catch {
    return fallback;
  }
}

export function savePrefs(prefs: CatalogPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // preferences are best-effort
  }
}

/** The subagent limits, as the backend's `SubagentLimits` spells them. */
export interface SubagentLimits {
  per_turn: number;
  concurrent: number;
  depth: number;
  per_day: number;
  slow_at: number;
  slow_to: number;
  stop_at: number;
  /** Pass 2 (2026-09-22): the share of the 5-hour window one message —
   *  the main thread plus every subagent and council seat — may spend
   *  before every further tool call is refused with "stop and report".
   *  Blocker 278, his answer: 35. */
  budget_pct: number;
  /** Pass 2: the model subagents run on. Blocker 280: the chat's own. */
  model: SubagentModel;
}

/** `chat` leaves a spawn's model as the parent wrote it; `sonnet` sets it
 *  (unless the parent asked for haiku). */
export type SubagentModel = "chat" | "sonnet";
export const SUBAGENT_MODELS: readonly SubagentModel[] = ["chat", "sonnet"];

/** The defaults, the backend's (`brief::SubagentLimits::default`): the
 *  6 of the first cap; ~~the CLI's own 20 at once~~ 4 at once (blocker
 *  279) and depth 3; no day cap (0); slow from 70% to 4, stop at 85%
 *  (blocker 271, his answer); 35% of the window a message (278); the
 *  chat's own model (280). */
export const DEFAULT_LIMITS: SubagentLimits = Object.freeze({
  per_turn: 6,
  concurrent: 4,
  depth: 3,
  // His answer to blocker 271 (2026-09-18): no day cap (0), slow to 4,
  // stop at 85 — ~~30 · 2 · 90~~.
  per_day: 0,
  slow_at: 70,
  slow_to: 4,
  stop_at: 85,
  budget_pct: 35,
  model: "chat",
}) as SubagentLimits;

/** A saved limits object, each number a whole number in range or the
 *  default; the model one of the two words or the default. */
export function readLimits(v: unknown): SubagentLimits {
  const out: SubagentLimits = { ...DEFAULT_LIMITS };
  if (v === null || typeof v !== "object") return out;
  const m = v as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof SubagentLimits)[]) {
    if (k === "model") {
      const s = m[k];
      if (s === "chat" || s === "sonnet") out.model = s;
      continue;
    }
    const n = m[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) continue;
    if ((k === "slow_at" || k === "stop_at" || k === "budget_pct") && n > 100) continue;
    out[k] = n;
  }
  return out;
}

export function loadLastConnection(): ConnectionDraft | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConnectionDraft>;
    if (typeof parsed.provider !== "string" || parsed.provider === "") {
      return null;
    }
    return {
      ...defaultDraft(),
      ...parsed,
      // Drafts saved before these knobs existed have neither field; an
      // absent value means on, so only an explicit false turns them off.
      preamble: parsed.preamble !== false,
      sidecar: parsed.sidecar !== false,
      // The same rule for the subagent switch (backlog 152): a draft
      // saved before it existed reads as on, its default.
      agentSubagentsAuto: parsed.agentSubagentsAuto !== false,
      // The limits (backlog 165): a draft from before them, or a field
      // that is not a whole number, reads as the default for that field.
      agentLimits: readLimits(parsed.agentLimits),
      approval: parsed.approval !== false,
      web: parsed.web !== false,
      knowledge: parsed.knowledge !== false,
      // The opposite reading to the five above, and deliberately: this one
      // used to be on unconditionally with `tools`, so an absent value means
      // a draft written before there was a switch — which is exactly the
      // state the switch exists to get out of. Only an explicit true is on.
      selfCompact: parsed.selfCompact === true,
      // A saved draft from before the agent engine has no `engine`, and the
      // engine it was written on is the one that existed. Anything else is
      // read strictly, so a stray value cannot land the rail on an engine
      // with no controls showing.
      engine: parsed.engine === "claude-code" ? "claude-code" : "provider",
    };
  } catch {
    return null;
  }
}

export function saveLastConnection(d: ConnectionDraft): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(d));
  } catch {
    // best-effort
  }
}
