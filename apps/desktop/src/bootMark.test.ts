import { describe, expect, it } from "vitest";
import mainSrc from "./main.ts?raw";
import { firstScriptDetail } from "./bootMark";

describe("the window's first-script mark (item 622b)", () => {
  it("is the first import of main.ts, so it runs before the rest of the bundle", () => {
    const firstImport = mainSrc.split("\n").find((l) => l.startsWith("import "));
    expect(firstImport).toBe('import "./bootMark";');
  });
  it("says how far into the page's load the first line ran", () => {
    expect(firstScriptDetail(1234.6)).toBe("page+1235 ms");
    expect(firstScriptDetail(-3)).toBe("page+0 ms");
  });
});
