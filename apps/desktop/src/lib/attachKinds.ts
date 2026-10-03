/**
 * What the composer does with a file (nightshift item 277). Pure, so the
 * accept rules and the chip's words are pinned by a test rather than by
 * a drop in the running app.
 *
 * His ask: a class `.pptx` said "not supported" here and went straight
 * into claude.ai. Five routes, decided by extension first and the media
 * type second — macOS often gives a dropped file an empty type:
 *
 * - **image** (png/jpeg/webp/gif) and **pdf**: as before.
 * - **office** (`.pptx .docx .xlsx`, legacy and OpenDocument): to a PDF by
 *   LibreOffice when it is installed, else its text (the backend's
 *   `attach::prepare_office`).
 * - **text**: sent as text, if its bytes are UTF-8 — a known text
 *   extension or not (`looksLikeText`), so an unnamed log file or a
 *   `Makefile` goes as text too. A notebook goes as its cells.
 * - **file**: anything else, on the Claude Code engine only — saved in the
 *   chat's folder and named in the message for the model to open. The
 *   API engine has no tools to open it with, so it refuses, saying why.
 */

export type Engine = "claude-code" | "api";

/** The route by name and type alone, before the bytes are read. */
export type Route = "image" | "pdf" | "office" | "text" | "maybe-text";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const IMAGE_EXTS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Office formats; `true` where the text can be pulled out without LibreOffice. */
export const OFFICE_EXTS: Record<string, boolean> = {
  pptx: true,
  ppsx: true,
  potx: true,
  pptm: true,
  docx: true,
  dotx: true,
  docm: true,
  xlsx: true,
  xltx: true,
  xlsm: true,
  odp: true,
  odt: true,
  ods: true,
  ppt: false,
  pps: false,
  doc: false,
  xls: false,
  key: false,
  rtf: false,
  pages: false,
  numbers: false,
};

/** Extensions read as text without a second look at the bytes' shape. */
export const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "rst", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini",
  "cfg", "conf", "xml", "html", "htm", "css", "scss", "svg", "tex", "bib", "log", "env", "sql",
  "py", "ipynb", "r", "jl", "m", "js", "mjs", "cjs", "ts", "tsx", "jsx", "svelte", "vue", "rs", "go",
  "java", "kt", "kts", "scala", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "pl", "lua",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "hs", "ml", "ex", "exs", "erl", "clj", "dart", "zig",
  "nim", "gradle", "cmake", "dockerfile", "makefile", "srt", "vtt",
]);

export function extOf(name: string): string {
  const leaf = name.split("/").pop() ?? name;
  const dot = leaf.lastIndexOf(".");
  // A leaf with no dot is its own "extension": `Makefile`, `Dockerfile`.
  return (dot > 0 ? leaf.slice(dot + 1) : leaf).toLowerCase();
}

/** The route a file takes by its name and type. `maybe-text` means: read
 *  the bytes, and it is text if they are UTF-8, else a file. */
export function routeOf(name: string, type: string): Route {
  const ext = extOf(name);
  if (IMAGE_TYPES.includes(type) || (!type && ext in IMAGE_EXTS)) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (ext in OFFICE_EXTS) return "office";
  if (TEXT_EXTS.has(ext) || type.startsWith("text/")) return "text";
  return "maybe-text";
}

/** The media type an image goes as when the drop gave none. */
export function imageType(name: string, type: string): string {
  return IMAGE_TYPES.includes(type) ? type : (IMAGE_EXTS[extOf(name)] ?? type);
}

/**
 * Text, by the bytes: valid UTF-8 (a BOM allowed) and no NUL in the first
 * 8 KB — the test `git` and `file` both use for "binary". An empty file is
 * text.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The most text one attachment carries as text (~150k tokens). A longer
 *  file is a file for Claude Code on that engine, refused on the other. */
export const MAX_TEXT_BYTES = 600 * 1024;

/** The most a file for Claude Code may be: it rides the send as base64. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The most an office file may be before conversion. */
export const MAX_OFFICE_BYTES = 100 * 1024 * 1024;

export type Decision =
  | { as: "text" }
  | { as: "file" }
  | { as: "refuse"; why: string };

/**
 * After the bytes are read: what a `text` or `maybe-text` file becomes on
 * this engine. Text that fits goes as text; text too long, or bytes that
 * are not text, go as a file on the Claude Code engine and are refused on
 * the API engine with the reason.
 */
export function decide(name: string, size: number, isText: boolean, engine: Engine): Decision {
  const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
  if (isText && size <= MAX_TEXT_BYTES) return { as: "text" };
  if (engine === "claude-code") {
    if (size > MAX_FILE_BYTES)
      return { as: "refuse", why: `${name} is ${mb(size)} — the limit for a file Claude Code opens itself is ${mb(MAX_FILE_BYTES)}` };
    return { as: "file" };
  }
  if (isText)
    return {
      as: "refuse",
      why: `${name} is ${Math.round(size / 1024)} KB of text — over the ${MAX_TEXT_BYTES / 1024} KB one message carries on the API engine. On the Claude Code engine it goes as a file the model opens itself`,
    };
  return {
    as: "refuse",
    why: `${name}: the API engine can take images, PDFs, office files and text — a .${extOf(name)} file needs the Claude Code engine, which saves it for the model to open with its own tools`,
  };
}

/** A Jupyter notebook as its cells, in order, outputs left out (they are
 *  often images or megabytes of tables). Not a notebook: the text as is. */
export function notebookText(json: string): string {
  try {
    const nb = JSON.parse(json) as { cells?: { cell_type?: string; source?: string | string[] }[] };
    if (!Array.isArray(nb.cells)) return json;
    return nb.cells
      .map((c, i) => {
        const src = Array.isArray(c.source) ? c.source.join("") : (c.source ?? "");
        return `# --- cell ${i + 1} (${c.cell_type ?? "code"}) ---\n${src}`;
      })
      .join("\n\n");
  } catch {
    return json;
  }
}

/** What an office file is, for the chip before and after conversion. */
export function officeUnit(name: string): "slides" | "document" | "sheet" {
  const ext = extOf(name);
  if (["pptx", "ppsx", "potx", "pptm", "odp", "ppt", "pps", "key"].includes(ext)) return "slides";
  if (["xlsx", "xltx", "xlsm", "ods", "xls", "numbers"].includes(ext)) return "sheet";
  return "document";
}

/** The chip's words while an office file converts. */
export function convertingLabel(name: string, converter: boolean): string {
  return converter ? `${officeUnit(name)} → PDF…` : `${officeUnit(name)} → text…`;
}

/** The chip's words once it has: what will be sent. */
export function convertedLabel(name: string, via: "pdf" | "text", count: number | null): string {
  const unit = officeUnit(name);
  if (via === "pdf") {
    const pages = count && count > 0 ? ` · ${count} page${count === 1 ? "" : "s"}` : "";
    return `${unit} → PDF${pages}`;
  }
  const what = unit === "slides" ? "slide" : unit === "sheet" ? "sheet" : null;
  const n = what && count ? ` · ${count} ${what}${count === 1 ? "" : "s"}` : "";
  return `${unit} → text${n}`;
}

/** The short badge on a chip or a transcript file button. */
export function badgeOf(a: { kind: string; media_type: string; name: string }): string {
  if (a.kind === "file") return extOf(a.name).slice(0, 5).toUpperCase() || "FILE";
  if (a.media_type === "application/pdf") return "PDF";
  if (a.media_type.startsWith("text/")) {
    const ext = extOf(a.name);
    return (ext in OFFICE_EXTS || ext.length > 5 ? "TXT" : ext.toUpperCase()) || "TXT";
  }
  return "FILE";
}
