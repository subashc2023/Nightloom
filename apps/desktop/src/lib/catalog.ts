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
export interface ConnectionDraft {
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
   * Folder the file tools are rooted at, and where the preamble looks for
   * project instructions. Empty means "whatever the app was launched from",
   * which is rarely what anyone wants — the rail shows what it resolved to.
   */
  workspace: string;
}

export function defaultDraft(): ConnectionDraft {
  return {
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
    workspace: "",
  };
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

// ---- persistence ----

const PREFS_KEY = "nightloom.catalog-prefs";
const LAST_KEY = "nightloom.last-connection";

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
      approval: parsed.approval !== false,
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
