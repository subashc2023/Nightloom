/*
 * Item 1007 (verify sweep 2): the hand-off text names HANDOFF.md, mdcheck and the backlog only where the
 * project has them. In the sweep's plain project (no HANDOFF.md, no backlog/) the wrap-up's first act was a
 * Bash hunt for HANDOFF.md and mdcheck.py, and the next chat's too. The project is told apart by the same
 * probe as backlog 431 (`noteCodeProject`, fed by the composer from HANDOFF.md / backlog/INDEX.md /
 * backlog/order.json at the project's top).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  PLAIN_READ_ORDER,
  PLAIN_WRAP_UP,
  READ_ORDER,
  WRAP_UP,
  clearDefaultReadOrder,
  defaultMessageFor,
  message,
  noteCodeProject,
  readOrder,
  setDefaultMessage,
  wrapUpToSend,
  writesHandoffFile,
} from "./handoff.svelte";

beforeEach(() => {
  setDefaultMessage(WRAP_UP);
  clearDefaultReadOrder();
  noteCodeProject("plain", false);
  noteCodeProject("code", true);
});

describe("1007: a project with no HANDOFF.md and no backlog/", () => {
  // ~~names neither file nor mdcheck; writesHandoffFile false; no read order~~ — item 1025 (blocker 2328
  // answered "always"): it writes HANDOFF.md again; what stays from 1007 is no mdcheck and no backlog step.
  it("gets a wrap-up that names no mdcheck or backlog, and still asks for the prompt", () => {
    const sent = wrapUpToSend("plain");
    expect(message("plain")).toBe(PLAIN_WRAP_UP);
    for (const word of ["mdcheck", "backlog", "blockers/INDEX.md", "practices"]) expect(sent).not.toContain(word);
    expect(sent).toContain("<handoff>");
    expect(sent).toContain("Hand-off contents (added by Nightloom):");
    expect(writesHandoffFile("plain")).toBe(true);
  });

  it("its continuation's read order names no index it does not keep", () => {
    expect(readOrder("plain")).toBe(PLAIN_READ_ORDER);
    expect(readOrder("plain")).not.toContain("INDEX.md");
  });

  it("an unknown project (no probe answer yet) reads as plain", () => {
    expect(defaultMessageFor("never-probed")).toBe(PLAIN_WRAP_UP);
  });
});

describe("1007: a project that keeps them is unchanged", () => {
  it("gets his practices' wrap-up and read order", () => {
    expect(message("code")).toBe(WRAP_UP);
    expect(wrapUpToSend("code")).toContain("mdcheck.py");
    expect(wrapUpToSend("code")).toContain("Give the new HANDOFF.md section these sub-headings");
    expect(writesHandoffFile("code")).toBe(true);
    expect(readOrder("code")).toBe(READ_ORDER);
  });
});

describe("1007: his own Settings text is his", () => {
  it("is sent as he wrote it in either project", () => {
    setDefaultMessage("Wrap up my way; write HANDOFF.md.");
    expect(message("plain")).toBe("Wrap up my way; write HANDOFF.md.");
    expect(message("code")).toBe("Wrap up my way; write HANDOFF.md.");
    setDefaultMessage(WRAP_UP);
  });
});
