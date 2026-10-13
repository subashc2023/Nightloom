import { afterEach, describe, expect, it } from "vitest";
import { render } from "svelte/server";
import composerSrc from "./Composer.svelte?raw";
import KeepButton from "./KeepButton.svelte";
import UserBubble from "./UserBubble.svelte";
import { app } from "./state.svelte";
import { canKeep, imageName, keepKey, keepLabel, keepTip, savedFilePaths } from "./keep";
import type { ProjectInfo } from "./types";

// Nightshift item 306: "there should be an option that you can just like
// keep it in the project" — every attachment kind item 277 accepts, on the
// composer's chip and a sent message's, copied into `.agents/files/`.

const project = (over: Partial<ProjectInfo> = {}) => ({ id: "ics51", name: "ICS 51", unfiled: false, ...over }) as ProjectInfo;

afterEach(() => {
  app.project = null;
});

describe("keep (pure)", () => {
  it("is offered only in a chat with a real project", () => {
    expect(canKeep(null)).toBe(false);
    expect(canKeep(project({ unfiled: true }))).toBe(false);
    expect(canKeep(project())).toBe(true);
  });

  it("says Keep, Keeping…, Kept — and where it went", () => {
    expect(keepLabel({ phase: "idle" })).toBe("Keep in project");
    expect(keepLabel({ phase: "keeping" })).toBe("Keeping…");
    expect(keepLabel({ phase: "kept", rel: "files/deck.pdf" })).toBe("Kept");
    expect(keepTip({ phase: "kept", rel: "files/deck.pdf" }, "deck.pptx")).toContain(".agents/files/deck.pdf");
    expect(keepTip({ phase: "idle" }, "deck.pptx", true)).toContain("still converting");
  });

  it("keys an attachment by its bytes, names a log image, reads a sent message's saved files", () => {
    expect(keepKey("a.pdf", "JVBERi0x")).toBe(keepKey("a.pdf", "JVBERi0x"));
    expect(keepKey("a.pdf", "JVBERi0x")).not.toBe(keepKey("a.pdf", "JVBERi0y"));
    expect(imageName(0, "image/jpeg")).toBe("image-1.jpg");
    expect(imageName(2, "image/png")).toBe("image-3.png");
    const one = "look\n\n[Attached a file — saved for you to open with your tools:\n- /w/.nightloom/attachments/c1/data.parquet]";
    expect(savedFilePaths(one)).toEqual(["/w/.nightloom/attachments/c1/data.parquet"]);
    const two = "[Attached files — saved for you to open with your tools:\n- /w/a.zip\n- /w/b (2).zip]";
    expect(savedFilePaths(two)).toEqual(["/w/a.zip", "/w/b (2).zip"]);
    expect(savedFilePaths("[Attached a cat picture]")).toEqual([]);
    expect(savedFilePaths("plain words")).toEqual([]);
  });
});

describe("KeepButton", () => {
  const props = { keyStr: "k", name: "1.3-assembly.pptx", mediaType: "application/pdf", from: { data: "JVBERi0x" } };

  it("is absent with no project, and in the unfiled holder", () => {
    expect(render(KeepButton, { props }).body).not.toContain("Keep");
    app.project = project({ unfiled: true });
    expect(render(KeepButton, { props }).body).not.toContain("Keep");
  });

  it("draws each state in a project", () => {
    app.project = project();
    const idle = render(KeepButton, { props }).body;
    expect(idle).toContain("Keep in project");
    expect(idle).not.toContain("disabled");
    const pending = render(KeepButton, { props: { ...props, pending: true } }).body;
    expect(pending).toContain("disabled");
    const kept = render(KeepButton, { props: { ...props, state: { phase: "kept", rel: "files/1.3-assembly.pdf" } } }).body;
    expect(kept).toContain("Kept");
    expect(kept).toContain("✓");
    expect(kept).toContain("disabled");
  });
});

describe("where the control is drawn", () => {
  it("a sent message offers Keep on its image, its documents and its saved files", () => {
    app.project = project();
    const body = render(UserBubble, {
      props: {
        images: [{ media_type: "image/png", data: "iVBORw0K" }],
        documents: [
          { media_type: "application/pdf", name: "1.3-assembly.pptx", data: "JVBERi0x" },
          { media_type: "text/plain", name: "main.rs", data: "Zm4gbWFpbigpIHt9" },
        ],
        text: "[Attached a file — saved for you to open with your tools:\n- /w/.nightloom/attachments/c1/data.parquet]",
      },
    }).body;
    expect(body.match(/Keep in project/g)?.length).toBe(4);
    expect(body).toContain("data.parquet");
  });

  it("a sent message in a chat with no project offers none", () => {
    const body = render(UserBubble, {
      props: { documents: [{ media_type: "application/pdf", name: "a.pdf", data: "JVBERi0x" }], text: "hi" },
    }).body;
    expect(body).not.toContain("Keep in project");
  });

  it("the composer's chip carries it, waiting on a conversion", () => {
    expect(composerSrc).toMatch(/<KeepButton[\s\S]*?from=\{\{ data: a\.data \}\}[\s\S]*?pending=\{!!a\.pending\}/);
  });
});
