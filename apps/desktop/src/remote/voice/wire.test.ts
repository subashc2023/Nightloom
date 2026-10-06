import { describe, expect, it } from "vitest";
import { AutoSend } from "./dictation";
import { FRAME_SAMPLES, Framer, Resampler, Uplink, leBytes, rmsDb, toInt16 } from "./pcm";
import { VoiceSocket, parseFrame, voiceUrl, type WireSocket } from "./socket";

describe("pcm", () => {
  it("48 kHz → 16 kHz: a third of the samples, the mean of each three", () => {
    const r = new Resampler(48000);
    const x = new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6, 0.9]);
    const y = r.push(x);
    expect(Array.from(y).map((v) => +v.toFixed(3))).toEqual([0.3, -0.6]);
    // The leftover sample carries into the next block.
    expect(r.push(new Float32Array([0.9, 0.9])).length).toBe(1);
  });

  it("44.1 kHz → 16 kHz keeps the rate over a second", () => {
    const r = new Resampler(44100);
    let n = 0;
    for (let i = 0; i < 100; i++) n += r.push(new Float32Array(441)).length;
    expect(Math.abs(n - 16000)).toBeLessThanOrEqual(1);
  });

  it("frames are 20 ms, 320 samples, whatever the block sizes", () => {
    const f = new Framer();
    const frames: Int16Array[] = [];
    f.push(new Float32Array(300), (x) => frames.push(x));
    expect(frames).toHaveLength(0);
    f.push(new Float32Array(700), (x) => frames.push(x));
    expect(frames).toHaveLength(3);
    expect(frames.every((x) => x.length === FRAME_SAMPLES)).toBe(true);
  });

  it("16-bit little-endian, clipped", () => {
    const s = toInt16(new Float32Array([1, -1, 2, 0]));
    expect(Array.from(s)).toEqual([32767, -32768, 32767, 0]);
    const b = new Uint8Array(leBytes(new Int16Array([0x0102, -2])));
    expect(Array.from(b)).toEqual([0x02, 0x01, 0xfe, 0xff]);
  });

  it("rmsDb: full scale ≈ 0, silence -120", () => {
    expect(rmsDb(new Int16Array(320).fill(32767))).toBeCloseTo(0, 0);
    expect(rmsDb(new Int16Array(320))).toBe(-120);
    expect(rmsDb(new Int16Array(320).fill(328))).toBeCloseTo(-40, 0);
  });

  it("uplink: nothing before speech, the pre-roll at onset, a long pause trimmed", () => {
    const u = new Uplink(300, 600);
    const fr = (n: number) => new Int16Array(FRAME_SAMPLES).fill(n);
    for (let i = 0; i < 40; i++) expect(u.push(fr(i), false, 0, false)).toEqual([]);
    // Onset: the frame, plus ~460 ms before it (23 frames).
    const first = u.push(fr(99), true, 0, true);
    expect(first).toHaveLength(23);
    expect(first[first.length - 1][0]).toBe(99);
    expect(u.push(fr(1), true, 0, false)).toHaveLength(1);
    // Into the pause: sent up to 600 ms, then held back.
    expect(u.push(fr(2), true, 600, false)).toHaveLength(1);
    expect(u.push(fr(3), true, 620, false)).toEqual([]);
    expect(u.push(fr(4), true, 1500, false)).toEqual([]);
    // He talks again: the pre-roll again, then live.
    expect(u.push(fr(5), true, 0, false).length).toBeGreaterThan(1);
    expect(u.push(fr(6), true, 0, false)).toHaveLength(1);
  });
});

describe("socket", () => {
  it("parses the host's frames and ignores what is not the protocol", () => {
    expect(parseFrame('{"t":"ready","chat":"c1","sample_rate":22050,"mic_rate":16000}')).toEqual({
      t: "ready",
      chat: "c1",
      sample_rate: 22050,
      mic_rate: 16000,
    });
    expect(parseFrame('{"t":"held","text":null}')).toEqual({ t: "held", text: null });
    expect(parseFrame('{"t":"sent","status":"queued"}')).toEqual({ t: "sent", status: "queued" });
    expect(parseFrame('{"t":"error","text":"x","message":"his words"}')).toEqual({ t: "error", text: "x", message: "his words" });
    expect(parseFrame('{"t":"approval","id":"t1","name":"Bash","text":"I need your OK"}')).toEqual({
      t: "approval",
      id: "t1",
      name: "Bash",
      text: "I need your OK",
    });
    expect(parseFrame('{"t":"approval","name":"no id"}')).toBeNull();
    expect(parseFrame('{"t":"audio","sentence":"no seq"}')).toBeNull();
    expect(parseFrame('{"t":"what"}')).toBeNull();
    expect(parseFrame("not json")).toBeNull();
  });

  it("wss on an HTTPS page, ws on plain HTTP; never the token in the URL", () => {
    expect(voiceUrl({ protocol: "https:", host: "mac.tail.ts.net:8642" })).toBe("wss://mac.tail.ts.net:8642/api/voice");
    expect(voiceUrl({ protocol: "http:", host: "100.1.2.3:8642" })).toBe("ws://100.1.2.3:8642/api/voice");
  });

  function wire() {
    const sent: (string | ArrayBuffer)[] = [];
    const w: WireSocket = {
      binaryType: "blob",
      readyState: 0,
      bufferedAmount: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (d) => void sent.push(d),
      close() {
        this.onclose?.({} as CloseEvent);
      },
    };
    return { w, sent };
  }

  it("the hello goes first with the token; audio headers pair with the next binary", () => {
    const { w, sent } = wire();
    const frames: string[] = [];
    const audio: [number, string][] = [];
    let closedClean: boolean | null = null;
    const s = new VoiceSocket("tok", "c1", {
      onFrame: (f) => frames.push(f.t),
      onAudio: (h, b) => audio.push([h.seq, new TextDecoder().decode(b)]),
      onClose: (clean) => (closedClean = clean),
    }, () => w);
    expect(w.binaryType).toBe("arraybuffer");
    // Nothing is sent before the socket opens.
    s.end();
    expect(sent).toEqual([]);
    w.readyState = 1;
    w.onopen!({} as Event);
    expect(JSON.parse(sent[0] as string)).toEqual({ t: "hello", token: "tok", chat: "c1" });
    w.onmessage!({ data: '{"t":"partial","text":"what"}' } as MessageEvent);
    w.onmessage!({ data: '{"t":"audio","seq":0,"sentence":"Hi."}' } as MessageEvent);
    w.onmessage!({ data: new TextEncoder().encode("WAV0").buffer } as MessageEvent);
    // A stray binary with no header is ignored.
    w.onmessage!({ data: new TextEncoder().encode("junk").buffer } as MessageEvent);
    expect(frames).toEqual(["partial"]);
    expect(audio).toEqual([[0, "WAV0"]]);
    s.audio(new ArrayBuffer(640));
    w.bufferedAmount = 100_000;
    s.audio(new ArrayBuffer(640));
    s.hush();
    s.unqueue();
    s.chat("c2");
    expect(sent.slice(1).map((x) => (typeof x === "string" ? JSON.parse(x).t : "bin"))).toEqual(["bin", "hush", "unqueue", "chat"]);
    s.close();
    expect(closedClean).toBe(true);
  });

  it("Speak it sends the text in a speak frame (wave 3 B2)", () => {
    const { w, sent } = wire();
    const s = new VoiceSocket("tok", "c1", { onFrame: () => {}, onAudio: () => {}, onClose: () => {} }, () => w);
    w.readyState = 1;
    w.onopen!({} as Event);
    s.speak("The fix is in. I've put the code on screen.");
    expect(JSON.parse(sent[1] as string)).toEqual({ t: "speak", text: "The fix is in. I've put the code on screen." });
  });
});

describe("dictation fallback", () => {
  function clock() {
    let now = 0;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let id = 0;
    return {
      set: ((fn: () => void, ms: number) => {
        timers.push({ at: now + ms, fn, id: ++id });
        return id;
      }) as unknown as typeof setTimeout,
      clear: ((i: number) => {
        const k = timers.findIndex((t) => t.id === i);
        if (k >= 0) timers.splice(k, 1);
      }) as unknown as typeof clearTimeout,
      advance(ms: number) {
        now += ms;
        for (const t of timers.filter((t) => t.at <= now)) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      },
    };
  }

  it("sends 2 s after the words stop, only while armed and never empty", () => {
    const c = clock();
    let sent = 0;
    const a = new AutoSend(() => sent++, 2000, c);
    a.changed("hello");
    c.advance(3000);
    expect(sent).toBe(0);
    a.arm();
    a.changed("what's the");
    c.advance(1500);
    a.changed("what's the weather");
    c.advance(1900);
    expect(sent).toBe(0);
    c.advance(200);
    expect(sent).toBe(1);
    a.changed("   ");
    c.advance(5000);
    expect(sent).toBe(1);
    a.changed("again");
    a.disarm();
    c.advance(5000);
    expect(sent).toBe(1);
  });
});
