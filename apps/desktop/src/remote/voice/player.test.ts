import { describe, expect, it } from "vitest";
import { Player, SeqQueue } from "./player";

describe("SeqQueue", () => {
  it("releases in seq order whatever order they arrive in", () => {
    const q = new SeqQueue<string>();
    expect(q.put(0, "a")).toEqual(["a"]);
    expect(q.put(2, "c")).toEqual([]);
    expect(q.put(3, "d")).toEqual([]);
    expect(q.put(1, "b")).toEqual(["b", "c", "d"]);
  });

  it("a new reply (reset) drops the rest of the last one", () => {
    const q = new SeqQueue<string>();
    q.put(0, "a");
    q.put(2, "stale");
    q.reset();
    expect(q.put(0, "new")).toEqual(["new"]);
    expect(q.put(1, "b")).toEqual(["b"]);
    expect(q.pending).toBe(0);
  });

  it("hush clears, and stays deaf to the hushed reply until the next reset", () => {
    const q = new SeqQueue<string>();
    q.put(0, "a");
    q.put(2, "c");
    q.hush();
    expect(q.pending).toBe(0);
    expect(q.put(1, "late")).toEqual([]);
    expect(q.put(3, "later")).toEqual([]);
    q.reset();
    expect(q.put(0, "next reply")).toEqual(["next reply"]);
  });
});

// ---- the Player against a stand-in AudioContext -------------------------------
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  constructor(private log: string[]) {}
  connect() {}
  start() {
    this.started = true;
    this.log.push("play " + (this.buffer as { name: string }).name);
  }
  stop() {
    this.stopped = true;
  }
  end() {
    this.onended?.();
  }
}

function fakeCtx() {
  const log: string[] = [];
  const sources: FakeSource[] = [];
  // decodeAudioData resolves when the test says, so order can be forced.
  const pending: { name: string; resolve: (b: unknown) => void }[] = [];
  const ctx = {
    destination: {},
    createAnalyser: () => ({ fftSize: 0, connect() {}, getByteTimeDomainData(a: Uint8Array) { a.fill(128); } }),
    createBufferSource: () => {
      const s = new FakeSource(log);
      sources.push(s);
      return s;
    },
    decodeAudioData: (buf: ArrayBuffer) =>
      new Promise((resolve) => pending.push({ name: new TextDecoder().decode(buf), resolve })),
  };
  const decode = async (name: string) => {
    const i = pending.findIndex((p) => p.name === name);
    const [p] = pending.splice(i, 1);
    p.resolve({ name });
    await Promise.resolve();
    await Promise.resolve();
  };
  return { ctx: ctx as unknown as AudioContext, log, sources, decode };
}
const wav = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("Player", () => {
  it("plays sentences in seq order even when a later one decodes first", async () => {
    const f = fakeCtx();
    const said: string[] = [];
    let idle = 0;
    const p = new Player(f.ctx, { onSentence: (l) => said.push(l.sentence), onIdle: () => idle++ });
    p.add({ seq: 0, sentence: "One." }, wav("s0"));
    p.add({ seq: 1, sentence: "Two." }, wav("s1"));
    await f.decode("s1");
    expect(f.log).toEqual([]);
    await f.decode("s0");
    expect(f.log).toEqual(["play s0"]);
    expect(p.busy).toBe(true);
    f.sources[0].end();
    expect(f.log).toEqual(["play s0", "play s1"]);
    f.sources[1].end();
    expect(said).toEqual(["One.", "Two."]);
    expect(p.busy).toBe(false);
    expect(idle).toBeGreaterThan(0);
  });

  it("barge-in: hush stops the sentence, drops the queue and the stragglers", async () => {
    const f = fakeCtx();
    const p = new Player(f.ctx);
    p.add({ seq: 0, sentence: "One." }, wav("s0"));
    p.add({ seq: 1, sentence: "Two." }, wav("s1"));
    await f.decode("s0");
    await f.decode("s1");
    expect(f.log).toEqual(["play s0"]);
    // A straggler of the same reply still decoding when he talks over it.
    p.add({ seq: 2, sentence: "Three." }, wav("s2"));
    p.hush();
    expect(f.sources[0].stopped).toBe(true);
    await f.decode("s2");
    f.sources[0].end();
    expect(f.log).toEqual(["play s0"]);
    expect(p.busy).toBe(false);
    // The next reply plays.
    p.add({ seq: 0, sentence: "Next." }, wav("n0"));
    await f.decode("n0");
    expect(f.log).toEqual(["play s0", "play n0"]);
  });

  it("a new reply's seq 0 drops the old reply's unplayed sentences", async () => {
    const f = fakeCtx();
    const p = new Player(f.ctx);
    p.add({ seq: 0, sentence: "Old." }, wav("o0"));
    p.add({ seq: 1, sentence: "Old two." }, wav("o1"));
    await f.decode("o0");
    p.add({ seq: 0, sentence: "New." }, wav("n0"));
    await f.decode("o1");
    await f.decode("n0");
    f.sources[0].end();
    expect(f.log).toEqual(["play o0", "play n0"]);
  });

  it("level is 0 when nothing plays", () => {
    const f = fakeCtx();
    expect(new Player(f.ctx).level()).toBe(0);
  });
});
