// Curated model catalog + user preferences for what the connection rail's
// dropdowns offer. Preferences persist in localStorage; the catalog itself
// is a starting point — the settings modal can hide entries or add custom
// model ids per provider.

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
  };
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
    return { ...defaultDraft(), ...parsed };
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
