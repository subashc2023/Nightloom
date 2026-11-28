// @vitest-environment happy-dom
// Item 771: Home's "Left behind?" block drawn from a mocked every-project listing — high first, its three
// answers, Left it's in-row Undo — and one block only when two rails mount (Split).
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../api", async (orig) => ({ ...((await orig()) as object), listEverySession: vi.fn() }));
import { flushSync, mount, tick, unmount } from "svelte";
import "../asides.svelte";
import * as api from "../api";
import { app } from "../state.svelte";
import { DAY_MS } from "../leftBehind";
import { noteOpened, resetLeftBehind } from "../leftBehind.svelte";
import LeftBehind from "./LeftBehind.svelte";

const roots: ReturnType<typeof mount>[] = [];
afterEach(() => {
  while (roots.length) unmount(roots.pop()!);
  document.body.innerHTML = "";
});
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const row = (id: string, replyAgo: number) =>
  ({ id, path: "", modified: ago(replyAgo), user_turns: 1, first_user: `Chat ${id}`, title: null, last_reply: ago(replyAgo), last_message: ago(replyAgo + 60_000), project: { id: "p", name: "Proj" } }) as api.ProjectChat;

async function draw(n = 1) {
  for (let i = 0; i < n; i++) roots.push(mount(LeftBehind, { target: document.body }));
  for (let i = 0; i < 5; i++) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync();
}

describe("771: Left behind? on Home", () => {
  it("lists high before low, with the answers, and Left it shows its Undo", async () => {
    resetLeftBehind(Date.now() - 30 * DAY_MS);
    app.activeSessionId = null;
    vi.mocked(api.listEverySession).mockResolvedValue([row("lo", 6 * DAY_MS), row("hi", 3 * DAY_MS)]);
    noteOpened("lo");
    await draw();
    const rows = [...document.querySelectorAll<HTMLElement>("[data-left-row]")];
    expect(rows.map((r) => r.dataset.leftRow)).toEqual(["hi", "lo"]);
    expect(rows[0].textContent).toContain("Not opened since the reply came");
    expect(rows[1].textContent).toContain("Opened, not read to the end");
    expect(rows[1].textContent).toContain("Open where I stopped");
    const leftIt = [...rows[0].querySelectorAll("button")].find((b) => b.textContent?.trim() === "Left it")!;
    leftIt.click();
    flushSync();
    const first = document.querySelector<HTMLElement>('[data-left-row="hi"]')!;
    expect(first.textContent).toContain("✓ settled");
    expect(first.querySelector(".lb-undo")?.textContent).toBe("Undo");
    first.querySelector<HTMLButtonElement>(".lb-undo")!.click();
    flushSync();
    expect(document.querySelector('[data-left-row="hi"]')?.textContent).toContain("Not opened since the reply came");
  });

  it("two rails mounted draw one block", async () => {
    resetLeftBehind(Date.now() - 30 * DAY_MS);
    vi.mocked(api.listEverySession).mockResolvedValue([row("hi", 3 * DAY_MS)]);
    await draw(2);
    expect(document.querySelectorAll("[data-left-behind]")).toHaveLength(1);
  });

  it("nothing left behind: no block", async () => {
    resetLeftBehind(Date.now() - 30 * DAY_MS);
    vi.mocked(api.listEverySession).mockResolvedValue([row("new", DAY_MS / 2)]);
    await draw();
    expect(document.querySelector("[data-left-behind]")).toBeNull();
  });
});
