/**
 * Item 1028: Node 25+ defines a global `localStorage` that is undefined without
 * `--localstorage-file`, and happy-dom will not replace a global that already
 * exists. Install the shared stand-in only when the one present is unusable, so
 * Node 20 (CI) keeps happy-dom's own.
 */
import { MemoryStorage } from "./memoryStorage";

let usable = false;
try {
  usable = typeof globalThis.localStorage?.clear === "function";
} catch {
  usable = false;
}
if (!usable) {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), writable: true, configurable: true });
}
