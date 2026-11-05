/**
 * Item 456: whether the composer offers typed maths back as LaTeX. On by
 * default (his ask), kept per machine in localStorage the way the format
 * toggle is (`composerFormat.svelte.ts`). Off, the composer never looks.
 */
const KEY = "nightloom.composer.typedMath";

export function loadTypedMathOn(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveTypedMathOn(on: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(KEY, on ? "1" : "0");
  } catch {
    // best-effort
  }
}

export const typedMathPrefs = $state({
  on: typeof localStorage === "undefined" ? true : loadTypedMathOn(),
});

export function setTypedMathOn(on: boolean): void {
  typedMathPrefs.on = on;
  saveTypedMathOn(on);
}

/**
 * Formulas he said no to, per draft key, by the text as typed: a denied
 * `s^2` is not offered again in that draft. Kept in memory only — a draft's
 * text is what persists (practices §7); the next draft starts clean.
 */
const denied = new Map<string, Set<string>>();

export function deniedFor(key: string): ReadonlySet<string> {
  return denied.get(key) ?? new Set();
}

export function denyTypedMath(key: string, srcs: string[]): void {
  const s = denied.get(key) ?? new Set<string>();
  for (const x of srcs) s.add(x);
  denied.set(key, s);
}

export function clearDenied(key: string): void {
  denied.delete(key);
}
