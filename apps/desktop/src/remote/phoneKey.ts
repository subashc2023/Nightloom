/*
 * This phone's own key (nightshift item 993g, blocker 2359): what makes a tap on the phone's sheet his.
 *
 * The paired token is one secret shared by every phone and kept on the Mac, so it cannot say a press came from his
 * phone. This key can: a P-256 key pair made here by the browser (WebCrypto), **not extractable** — the page can ask
 * the browser to sign with it and can never read it — kept in this page's IndexedDB. The Mac holds only the public
 * half, and only after his Allow click in the Mac's window. Each tap is signed here (`tapMessage`: the tap's id and
 * the Mac's fresh challenge for it), and the Mac runs a card action only on that signature (`phone_keys.rs`).
 *
 * The key belongs to this page's storage: Safari and the Home Screen icon keep separate storage on an iPhone, so each
 * is its own "phone" to allow; clearing Safari's website data removes the key, and the phone asks again. WebCrypto
 * exists only on a secure page (https), so the plain http link reads and cannot send.
 */

export const NEEDS_HTTPS = "Sending from here needs the https:// link (Settings → Phone on the Mac shows it). You can still read and copy.";

/** What a phone signs for one tap (`phone_keys.rs` `tap_message`). */
export const tapMessage = (tap: string, challenge: string) => `nightloom-tap-v1\n${tap}\n${challenge}`;

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** A new key pair whose private half can sign and can never be read out. */
export function newPair(subtle: SubtleCrypto = crypto.subtle): Promise<CryptoKeyPair> {
  return subtle.generateKey(ALG, false, ["sign"]) as Promise<CryptoKeyPair>;
}
/** The public half as the Mac keeps it: the uncompressed point, base64url. */
export async function publicOf(pair: CryptoKeyPair, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  return b64url(await subtle.exportKey("raw", pair.publicKey));
}
/** The signature the Mac verifies: 64 bytes r‖s, base64url. */
export async function signWith(pair: CryptoKeyPair, message: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  return b64url(await subtle.sign(SIGN, pair.privateKey, new TextEncoder().encode(message)));
}

/** The phone's key, as the sheet uses it. */
export interface PhoneSigner {
  /** Why this page cannot hold a key (not https), else null. */
  cannot(): string | null;
  /** This page's key if it has made one: its public half. Never makes one. */
  have(): Promise<string | null>;
  /** This page's key, made now if there is none: its public half. */
  make(): Promise<string>;
  /** This page's signature over `message`. Throws when there is no key. */
  sign(message: string): Promise<string>;
}

const DB = "nightloom-phone-key";
const STORE = "keys";
const SLOT = "tap";

function db(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error ?? new Error("this browser would not open its key store"));
  });
}
async function stored(): Promise<CryptoKeyPair | null> {
  const d = await db();
  try {
    return await new Promise((ok, no) => {
      const r = d.transaction(STORE, "readonly").objectStore(STORE).get(SLOT);
      r.onsuccess = () => ok((r.result as CryptoKeyPair | undefined) ?? null);
      r.onerror = () => no(r.error);
    });
  } finally {
    d.close();
  }
}
async function store(pair: CryptoKeyPair): Promise<void> {
  const d = await db();
  try {
    await new Promise<void>((ok, no) => {
      const t = d.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(pair, SLOT);
      t.oncomplete = () => ok();
      t.onerror = () => no(t.error);
      t.onabort = () => no(t.error);
    });
  } finally {
    d.close();
  }
}

/** The real signer: WebCrypto and this page's IndexedDB. */
export function webSigner(): PhoneSigner {
  let pair: CryptoKeyPair | null = null;
  const load = async () => (pair ??= await stored());
  return {
    cannot: () =>
      typeof window !== "undefined" && window.isSecureContext && typeof crypto !== "undefined" && !!crypto.subtle && typeof indexedDB !== "undefined"
        ? null
        : NEEDS_HTTPS,
    have: async () => {
      const p = await load();
      return p ? publicOf(p) : null;
    },
    make: async () => {
      let p = await load();
      if (!p) {
        p = await newPair();
        await store(p);
        pair = p;
      }
      return publicOf(p);
    },
    sign: async (message) => {
      const p = await load();
      if (!p) throw new Error("This phone has no key of its own yet, so nothing was sent.");
      return signWith(p, message);
    },
  };
}

/** What this page calls itself on the Mac's list. Its own claim only: the code is what he checks. */
export function phoneName(ua: string = navigator.userAgent, standalone: boolean = isStandalone()): string {
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android phone" : /Macintosh/.test(ua) ? "Mac browser" : "A browser";
  const browser = standalone ? "Home Screen app" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${device} · ${browser}`;
}
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || !!window.matchMedia?.("(display-mode: standalone)").matches;
}

/** A six-digit code as both screens show it: "123 456". */
export const spacedCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
