import { describe, expect, it } from "vitest";
import { mediaCandidates } from "./replyMedia";
import promptSrc from "../../../../crates/nightloom-service/src/prompt.rs?raw";

// Item 822: what the drawing toolchain writes reaches 820's strip under the
// reply when the chat names it the way the engine note (DRAW_NOTE) says.

const ROOT = "/Users/demo/work/draw";
const note = /pub const DRAW_NOTE: &str = "([^\n]*)";/.exec(promptSrc)![1];

describe("the drawing toolchain's output under a reply", () => {
  it("the note names dot, the env's python and manim, and Manim's output path", () => {
    expect(note).toContain("dot -Tpng g.dot -o g.png");
    expect(note).toContain("~/.nightloom/draw-env/bin/python");
    expect(note).toContain("~/.nightloom/draw-env/bin/manim -ql scene.py Name");
    expect(note).toContain("media/videos/scene/480p15/Name.mp4");
    expect(note).toContain("absolute path");
  });
  it("finds a Graphviz PNG and Manim's MP4 named by absolute path, in order", () => {
    const text =
      `The graph is at ${ROOT}/g.png, and the clip is at ${ROOT}/media/videos/scene/480p15/Name.mp4.`;
    expect(mediaCandidates(text, [ROOT]).map((c) => [c.path, c.kind])).toEqual([
      [`${ROOT}/g.png`, "image"],
      [`${ROOT}/media/videos/scene/480p15/Name.mp4`, "video"],
    ]);
  });
  it("finds Manim's relative media/ path when backticked, against the chat's folder", () => {
    const got = mediaCandidates("Rendered `media/videos/scene/480p15/Name.mp4` and `g.png`.", [ROOT]);
    expect(got.map((c) => c.path)).toEqual([`${ROOT}/media/videos/scene/480p15/Name.mp4`, `${ROOT}/g.png`]);
  });
  it("misses Manim's relative media/ path written bare — which is why the note asks for an absolute path", () => {
    expect(mediaCandidates("Rendered media/videos/scene/480p15/Name.mp4.", [ROOT])).toEqual([]);
  });
  it("finds the ~/ form of the env's own output folder", () => {
    const got = mediaCandidates("Saved ~/scratch/media/videos/s/1080p60/S.mp4", [ROOT]);
    expect(got.map((c) => [c.path, c.kind])).toEqual([["~/scratch/media/videos/s/1080p60/S.mp4", "video"]]);
  });
});
