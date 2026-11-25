import { describe, expect, it, vi } from "vitest";
import { parsePromptLink, projectNamed, promptLinkFor, stripHidden, withPrompt } from "./promptLinks";
import { openPromptLink, type LinkDeps } from "./promptLinks.svelte";
import type { ProjectInfo } from "./types";
import stateSrc from "./state.svelte.ts?raw";
import plist from "../../src-tauri/Info.plist?raw";

const proj = (id: string, name: string) => ({ id, name, root: `/p/${id}` }) as ProjectInfo;

describe("976: reading a prompt link", () => {
  it("project and prompt, decoded", () => {
    expect(parsePromptLink("nightloom://new?project=Nightloom&prompt=Read%20HANDOFF.md%0Athen%20go")).toEqual({
      project: "Nightloom",
      prompt: "Read HANDOFF.md\nthen go",
      removed: 0,
    });
    expect(parsePromptLink("nightloom://new?prompt=a+b")).toEqual({ project: null, prompt: "a b", removed: 0 });
    expect(parsePromptLink("nightloom:new?prompt=x")?.prompt).toBe("x");
  });
  it("not a prompt link: another scheme or verb, no prompt, an empty one", () => {
    for (const bad of ["https://new?prompt=x", "nightloom://send?prompt=x", "nightloom://new?project=A", "nightloom://new?prompt=%20%20", "not a url"])
      expect(parsePromptLink(bad)).toBeNull();
  });
  it("hidden characters stripped and counted; tabs and newlines kept", () => {
    expect(stripHidden("a​b‮c﻿d\u0007\te\r\nf")).toEqual({ text: "abcd\te\nf", removed: 4 });
    expect(parsePromptLink("nightloom://new?prompt=" + encodeURIComponent("run⁦ rm -rf⁩"))).toEqual({ project: null, prompt: "run rm -rf", removed: 2 });
  });
  it("a project by id or by name, ignoring case", () => {
    const ps = [proj("p1", "Nightloom"), proj("p2", "nightshift")];
    expect(projectNamed(ps, "nightloom")?.id).toBe("p1");
    expect(projectNamed(ps, "p2")?.id).toBe("p2");
    expect(projectNamed(ps, "other")).toBeNull();
  });
  it("never over his words; a link is made the way it is read", () => {
    expect(withPrompt("", "go")).toBe("go");
    expect(withPrompt("my words  ", "go")).toBe("my words\n\ngo");
    const link = promptLinkFor("Read HANDOFF.md & go", "Night loom");
    expect(parsePromptLink(link)).toEqual({ project: "Night loom", prompt: "Read HANDOFF.md & go", removed: 0 });
  });
});

function deps(over: Partial<LinkDeps> = {}) {
  const boxes: Record<string, string> = {};
  let current: string | null = "p0";
  const d: LinkDeps & { boxes: typeof boxes; toasts: string[]; calls: string[] } = {
    boxes,
    toasts: [],
    calls: [],
    projects: () => [proj("p0", "Home"), proj("p1", "Nightloom")],
    current: () => current,
    useProject: vi.fn(async (id: string) => {
      d.calls.push(`project:${id}`);
      current = id;
    }),
    showChat: () => d.calls.push("show"),
    newChat: vi.fn(async () => {
      d.calls.push("new");
    }),
    boxKey: () => `new:${current}`,
    readBox: (k) => boxes[k] ?? "",
    writeBox: (k, t) => {
      boxes[k] = t;
    },
    toast: (t) => d.toasts.push(t),
    ...over,
  };
  return d;
}

describe("976: where a prompt link goes", () => {
  it("its project, a New chat, the prompt in the box — and nothing sent", async () => {
    const d = deps();
    expect(await openPromptLink("nightloom://new?project=nightloom&prompt=hello", d)).toBe("new:p1");
    expect(d.calls).toEqual(["project:p1", "show", "new"]);
    expect(d.boxes["new:p1"]).toBe("hello");
    expect(d.toasts).toEqual(["The link's prompt is in the message box — nothing was sent"]);
  });
  it("the project already open is not reopened", async () => {
    const d = deps();
    await openPromptLink("nightloom://new?project=Home&prompt=x", d);
    expect(d.calls).toEqual(["show", "new"]);
  });
  it("an unknown project: a toast naming it, the prompt kept in a New chat here", async () => {
    const d = deps();
    expect(await openPromptLink("nightloom://new?project=Nope&prompt=keep%20me", d)).toBe("new:p0");
    expect(d.boxes["new:p0"]).toBe("keep me");
    expect(d.toasts[0]).toContain("No project is named “Nope”");
  });
  it("words already in that New chat stay, the prompt after them; hidden characters are told", async () => {
    const d = deps();
    d.boxes["new:p1"] = "half typed";
    await openPromptLink("nightloom://new?project=p1&prompt=go%E2%80%8B", d);
    expect(d.boxes["new:p1"]).toBe("half typed\n\ngo");
    expect(d.toasts[0]).toContain("1 hidden character was removed");
  });
  it("a link with no prompt opens nothing", async () => {
    const d = deps();
    expect(await openPromptLink("nightloom://new?project=p1", d)).toBeNull();
    expect(d.calls).toEqual([]);
    expect(d.toasts[0]).toContain("no prompt");
  });
  it("installed at launch after the restored tabs; the bundle claims the scheme", () => {
    const after = stateSrc.indexOf("await restoreTabs({ newProjectFront");
    expect(stateSrc.indexOf("m.installPromptLinks()")).toBeGreaterThan(after);
    expect(plist).toContain("<key>CFBundleURLSchemes</key>");
    expect(plist).toContain("<string>nightloom</string>");
  });
});
