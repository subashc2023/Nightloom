import { describe, expect, it, vi } from "vitest";
import { isZip, keepDropped, zipToast, type KeepDeps, type ZipDeps } from "./notesDrop";
import type { Attachment } from "./types";
import type { UnpackedZip } from "./api";

const b64 = (s: string) => btoa(s);

/** Deps where `attach` refuses names in `refuse` (naming them, as acceptFiles' toasts do). */
function deps(unpacked: UnpackedZip | Error, refuse: string[] = []) {
  const boxes: Record<string, Attachment[]> = {};
  let id = 0;
  const kept: { name: string; dir: string; data: string }[] = [];
  const d: KeepDeps = {
    project: () => ({}),
    toast: vi.fn(),
    attach: vi.fn(async (key: string, files: File[], toast?: (t: string) => void) => {
      const made: Attachment[] = [];
      for (const f of files) {
        if (refuse.includes(f.name)) {
          (toast ?? (() => {}))(`${f.name}: the API engine can take images, PDFs, office files and text`);
          continue;
        }
        const data = btoa(new TextDecoder().decode(new Uint8Array(await f.arrayBuffer())));
        made.push({ id: ++id, kind: "document", name: f.name, media_type: "text/plain", data });
      }
      boxes[key] = [...(boxes[key] ?? []), ...made];
      return made;
    }),
    jobs: () => [],
    chips: (key) => boxes[key] ?? [],
    state: () => ({ phase: "idle" }),
    forget: vi.fn(),
    keep: vi.fn(async () => {}),
    discard: vi.fn((key: string) => void delete boxes[key]),
  };
  const z: ZipDeps = {
    read: vi.fn(async () => "ZIPDATA"),
    unpack: vi.fn(async () => {
      if (unpacked instanceof Error) throw "bundle.zip is not a readable zip (invalid Zip archive)";
      return unpacked;
    }),
    keepAt: vi.fn(async (name: string, _m: string, data: string, dir: string) => {
      kept.push({ name, dir, data });
      return { rel: `files/${dir}/${name}`, already: false };
    }),
    kept: vi.fn(async () => {}),
  };
  d.zip = z;
  return { d, z, kept, boxes };
}

const zipFile = (name = "bundle.zip") => new File(["PK"], name, { type: "application/zip" });

describe("a zip dropped on Notes (item 414)", () => {
  it("knows a zip by its name or type", () => {
    expect(isZip({ name: "a.ZIP" })).toBe(true);
    expect(isZip({ name: "a", type: "application/x-zip-compressed" })).toBe(true);
    expect(isZip({ name: "a.pdf", type: "application/pdf" })).toBe(false);
  });

  it("unpacks into its folder, nested paths kept as folders, one toast for the whole zip", async () => {
    const { d, z, kept, boxes } = deps({
      folder: "bundle",
      files: [
        { path: "a.txt", data: b64("one") },
        { path: "sub/b.md", data: b64("two") },
        { path: "sub/deep/c.txt", data: b64("three") },
      ],
      skipped: [{ name: "__MACOSX/._a.txt", why: "system file" }],
    });
    const n = await keepDropped([zipFile()], d);
    expect(n).toBe(3);
    expect(z.read).toHaveBeenCalledTimes(1);
    expect(kept.map((k) => `${k.dir}|${k.name}`)).toEqual(["bundle|a.txt", "bundle/sub|b.md", "bundle/sub/deep|c.txt"]);
    expect(kept[1].data).toBe(b64("two"));
    expect(z.kept).toHaveBeenCalledWith(["files/bundle/a.txt", "files/bundle/sub/b.md", "files/bundle/sub/deep/c.txt"], true);
    expect(d.toast).toHaveBeenCalledTimes(1);
    expect(d.toast).toHaveBeenCalledWith("Kept 3 files from bundle.zip in files/bundle/ · 1 skipped (1 system file)");
    // The zip itself never went through attach or Keep, and the scratch box is gone.
    expect((d.attach as ReturnType<typeof vi.fn>).mock.calls.every((c) => c[1][0].name !== "bundle.zip")).toBe(true);
    expect(d.keep).not.toHaveBeenCalled();
    expect(Object.keys(boxes)).toEqual([]);
  });

  it("an entry the usual rules refuse is skipped and named, with its reason", async () => {
    const { d } = deps(
      { folder: "b (2)", files: [{ path: "x.bin", data: b64("x") }, { path: "ok.txt", data: b64("y") }], skipped: [] },
      ["x.bin"],
    );
    expect(await keepDropped([zipFile("b.zip")], d)).toBe(1);
    expect(d.toast).toHaveBeenCalledTimes(1);
    expect(d.toast).toHaveBeenCalledWith(
      "Kept 1 file from b.zip in files/b (2)/ · 1 skipped (x.bin) — x.bin: the API engine can take images, PDFs, office files and text",
    );
  });

  it("an empty zip says so and keeps nothing", async () => {
    const { d, z } = deps({ folder: "e", files: [], skipped: [] });
    expect(await keepDropped([zipFile("e.zip")], d)).toBe(0);
    expect(d.toast).toHaveBeenCalledWith("e.zip is empty — nothing to keep");
    expect(z.keepAt).not.toHaveBeenCalled();
    expect(z.kept).not.toHaveBeenCalled();
  });

  it("a corrupt zip gets a clear toast", async () => {
    const { d, z } = deps(new Error("corrupt"));
    expect(await keepDropped([zipFile()], d)).toBe(0);
    expect(d.toast).toHaveBeenCalledWith("Could not open bundle.zip: bundle.zip is not a readable zip (invalid Zip archive)");
    expect(z.keepAt).not.toHaveBeenCalled();
  });

  it("a zip with only refused entries keeps nothing and says why", async () => {
    const { d, z } = deps({
      folder: "s",
      files: [],
      skipped: [
        { name: "../evil.txt", why: "path leads outside the folder" },
        { name: ".DS_Store", why: "system file" },
      ],
    });
    expect(await keepDropped([zipFile("s.zip")], d)).toBe(0);
    expect(z.kept).not.toHaveBeenCalled();
    expect(d.toast).toHaveBeenCalledWith(
      "Kept nothing from s.zip · 2 skipped (1 system file; ../evil.txt) — evil.txt: path leads outside the folder",
    );
  });

  it("other files dropped with a zip are kept as before", async () => {
    const { d, kept } = deps({ folder: "z", files: [{ path: "a.txt", data: b64("a") }], skipped: [] });
    const n = await keepDropped([new File(["x"], "deck.pdf"), zipFile("z.zip")], d);
    expect(n).toBe(2);
    expect(d.keep).toHaveBeenCalledTimes(1);
    expect(kept.map((k) => k.dir)).toEqual(["z"]);
  });

  it("names at most three skipped entries", () => {
    const s = ["a", "b", "c", "d", "e"].map((n) => ({ name: n, why: "too large" }));
    expect(zipToast("big.zip", "big", 2, s)).toBe("Kept 2 files from big.zip in files/big/ · 5 skipped (a, b, c, +2 more) — a: too large");
  });
});
