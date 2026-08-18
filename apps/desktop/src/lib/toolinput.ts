// Rendering helpers for a tool call's JSON input, shared by the transcript
// chip (one line, elided by CSS) and the approval prompt (values in full).

export function compactJson(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "null";
  } catch {
    return String(input);
  }
}

export interface InputField {
  /** Argument name; empty for an input that is not an object. */
  key: string;
  value: string;
}

/**
 * A call's arguments as labelled fields, strings kept verbatim.
 *
 * The approval prompt needs the argument itself, not a summary of it: the
 * decision to allow `bash` *is* the decision about that one command, and a
 * command squeezed onto a single JSON line with escaped quotes is not
 * something anyone can consent to.
 */
export function inputFields(input: unknown): InputField[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [{ key: "", value: compactJson(input) }];
  }
  return Object.entries(input as Record<string, unknown>).map(
    ([key, value]) => ({
      key,
      value: typeof value === "string" ? value : compactJson(value),
    }),
  );
}
