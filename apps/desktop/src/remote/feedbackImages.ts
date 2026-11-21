/**
 * The phone sheet's images (item 815): a photo picked with "Add a photo"
 * or a screenshot pasted into the box. Kept in the page's IndexedDB on
 * every change (photos are too big for localStorage), so closing the
 * sheet, another chat and a reload bring them back with the words; only a
 * send that landed or a confirmed Discard clears them. Where IndexedDB is
 * missing they live in memory for the page's life.
 */
import { FEEDBACK_IMAGE_TYPES, MAX_FEEDBACK_IMAGE_BASE64 } from "../lib/feedbackText";

/** The phone sheet takes at most this many (the listener's `PHONE_IMAGES`). */
export const MAX_PHONE_IMAGES = 4;

export interface PhoneImage {
  /** Base64, no `data:` prefix. */
  data: string;
  type: string;
}

const DB = "nightloom-phone-feedback";
const STORE = "images";
const KEY = "draft";

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadPhoneImages(): Promise<PhoneImage[]> {
  const d = await db();
  if (!d) return [];
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as PhoneImage[]) : []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Keep them (none: the entry goes). Best-effort. */
export async function savePhoneImages(images: PhoneImage[]): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      if (images.length) store.put(plainCopy(images), KEY);
      else store.delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function plainCopy<T>(v: T): T {
  // Svelte's state proxies cannot be structured-cloned; plain copies can.
  return JSON.parse(JSON.stringify(v)) as T;
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

/** The longest side a re-drawn photo keeps. */
const LONG_SIDE = 2400;

/**
 * A picked or pasted file as the service takes it: a PNG, JPEG, WebP or GIF
 * under the cap goes as it is; anything else (an iPhone's HEIC, a 12 MB
 * photo) is re-drawn as a JPEG, its long side at most 2400 px. Null when
 * the browser cannot draw it.
 */
export async function sendable(file: Blob): Promise<PhoneImage | null> {
  if (FEEDBACK_IMAGE_TYPES.has(file.type)) {
    const data = await base64Of(file);
    if (data.length <= MAX_FEEDBACK_IMAGE_BASE64) return { data, type: file.type };
  }
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, LONG_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.85);
    const data = url.slice(url.indexOf(",") + 1);
    return data.length <= MAX_FEEDBACK_IMAGE_BASE64 ? { data, type: "image/jpeg" } : null;
  } catch {
    return null;
  }
}
