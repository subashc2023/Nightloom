/**
 * The voice socket's phone half (item 246 wave 3). The frames are those of
 * `crates/nightloom-service/src/voice/session.rs`'s module doc — the
 * protocol's reference: the token rides the first frame (`hello`), never
 * the URL; binary frames up are 16 kHz PCM; `audio` headers down are each
 * followed by one binary WAV.
 */

/** `/api/state`'s `voice` (the service crate's `VoiceInfo`), or null
 *  when this host has no voice programs (bin/voice-setup.sh). */
export interface VoiceInfo {
  sample_rate: number | null;
  mic_rate: number;
  voice: string;
}

/** What the host says, parsed. */
export type HostFrame =
  | { t: "ready"; chat: string | null; sample_rate: number | null; mic_rate: number }
  | { t: "partial"; text: string }
  | { t: "final"; text: string; stt_ms?: number }
  | { t: "dropped"; reason: "short" | "noise"; text: string }
  | { t: "held"; text: string | null }
  | { t: "sent"; status: "sent" | "queued" }
  | { t: "audio"; seq: number; sentence: string; bytes?: number; since_end_ms?: number; first_text_ms?: number | null }
  | { t: "reply_end" }
  | { t: "error"; text: string; message?: string };

/** Parse one text frame; `null` for anything not in the protocol. */
export function parseFrame(text: string): HostFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  switch (f.t) {
    case "ready":
      return { t: "ready", chat: (f.chat as string) ?? null, sample_rate: (f.sample_rate as number) ?? null, mic_rate: Number(f.mic_rate ?? 16000) };
    case "partial":
    case "final":
      return typeof f.text === "string" ? (f as HostFrame) : null;
    case "dropped":
      return { t: "dropped", reason: f.reason === "noise" ? "noise" : "short", text: String(f.text ?? "") };
    case "held":
      return { t: "held", text: typeof f.text === "string" ? f.text : null };
    case "sent":
      return { t: "sent", status: f.status === "queued" ? "queued" : "sent" };
    case "audio":
      return typeof f.seq === "number" ? (f as HostFrame) : null;
    case "reply_end":
      return { t: "reply_end" };
    case "error":
      return { t: "error", text: String(f.text ?? "Voice failed"), ...(typeof f.message === "string" ? { message: f.message } : {}) };
    default:
      return null;
  }
}

/** `/api/voice` on this page's own host, `wss:` when the page is HTTPS. */
export function voiceUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/api/voice`;
}

export interface SocketEvents {
  onFrame: (f: HostFrame) => void;
  /** An `audio` header's WAV arrived. */
  onAudio: (head: Extract<HostFrame, { t: "audio" }>, wav: ArrayBuffer) => void;
  /** The socket closed — `clean` when we closed it. */
  onClose: (clean: boolean) => void;
}

/** The part of `WebSocket` this uses — so a test can hand in a fake. */
export interface WireSocket {
  binaryType: BinaryType;
  readyState: number;
  bufferedAmount: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export class VoiceSocket {
  private ws: WireSocket;
  private head: Extract<HostFrame, { t: "audio" }> | null = null;
  private closing = false;

  constructor(
    token: string,
    chat: string | null,
    readonly on: SocketEvents,
    make: () => WireSocket = () => new WebSocket(voiceUrl(location)) as unknown as WireSocket,
  ) {
    this.ws = make();
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this.ws.send(JSON.stringify({ t: "hello", token, chat }));
    this.ws.onmessage = (ev) => this.message(ev.data);
    this.ws.onerror = () => {};
    this.ws.onclose = () => this.on.onClose(this.closing);
  }

  get open(): boolean {
    return this.ws.readyState === 1;
  }

  private message(data: unknown): void {
    if (typeof data === "string") {
      const f = parseFrame(data);
      if (!f) return;
      if (f.t === "audio") this.head = f;
      else this.on.onFrame(f);
      return;
    }
    if (data instanceof ArrayBuffer && this.head) {
      const head = this.head;
      this.head = null;
      this.on.onAudio(head, data);
    }
  }

  private say(v: Record<string, unknown>): void {
    if (this.open) this.ws.send(JSON.stringify(v));
  }

  /** 16 kHz PCM, little-endian (dropped rather than piled up when the
   *  link stalls — ~1 s behind is already too late to be live). */
  audio(bytes: ArrayBuffer): void {
    if (this.open && this.ws.bufferedAmount < 64_000) this.ws.send(bytes);
  }
  end(): void {
    this.say({ t: "end" });
  }
  cancel(): void {
    this.say({ t: "cancel" });
  }
  hush(): void {
    this.say({ t: "hush" });
  }
  unqueue(): void {
    this.say({ t: "unqueue" });
  }
  chat(chat: string | null): void {
    this.say({ t: "chat", chat });
  }
  /** "Speak it" (wave 3 B2): the host reads `text` aloud as reply audio
   *  (`audio` frames, then `reply_end`) — nothing goes to the chat. */
  speak(text: string): void {
    this.say({ t: "speak", text });
  }

  close(): void {
    this.closing = true;
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}
