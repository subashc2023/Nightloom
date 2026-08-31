/**
 * The one browser global the suite needs.
 *
 * `catalog.ts` persists preferences in localStorage and `state.svelte.ts` reads
 * three of them at module load. Both wrap every access in try/catch, so the
 * absence of the global is survivable — but a preference test that can only
 * observe the catch arm is not testing the migration it claims to. This is an
 * in-memory stand-in with the four methods those modules call, reset between
 * files by vitest's fresh module registry rather than by anything here.
 */
class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  writable: true,
  configurable: true,
});
