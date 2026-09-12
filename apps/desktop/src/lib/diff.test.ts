import { describe, expect, it } from "vitest";
import { diffTotals, pairLines, parseDiff } from "./diff";

const SAMPLE = `diff --git a/notes/a.md b/notes/a.md
index 1111111..2222222 100644
--- a/notes/a.md
+++ b/notes/a.md
@@ -1,4 +1,5 @@
 first
-second
-third
+SECOND
+third, revised
+fourth
 last
@@ -20,2 +21,2 @@ heading
 keep
-gone
+here
diff --git a/new.py b/new.py
new file mode 100644
--- /dev/null
+++ b/new.py
@@ -0,0 +1,2 @@
+print(1)
+print(2)
\\ No newline at end of file
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

describe("parseDiff", () => {
  it("splits files, counts lines and reads hunk headers", () => {
    const files = parseDiff(SAMPLE);
    expect(files.map((f) => f.path)).toEqual(["notes/a.md", "new.py", "img.png"]);
    expect(files[0].added).toBe(4);
    expect(files[0].removed).toBe(3);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[1].header).toBe("@@ -20,2 +21,2 @@ heading");
    expect(files[1].oldPath).toBeNull();
    expect(files[1].added).toBe(2);
    expect(files[2].binary).toBe(true);
    expect(diffTotals(files)).toEqual({ added: 6, removed: 3, files: 3 });
  });

  it("pairs a removal run with an addition run and pads the shorter side", () => {
    const rows = parseDiff(SAMPLE)[0].hunks[0].rows;
    // first (ctx), 2 dels vs 3 adds → 3 rows, last (ctx)
    expect(rows).toHaveLength(5);
    expect(rows[0].left).toEqual({ no: 1, text: "first", kind: "ctx" });
    expect(rows[0].right.no).toBe(1);
    expect(rows[1].left).toEqual({ no: 2, text: "second", kind: "del" });
    expect(rows[1].right).toEqual({ no: 2, text: "SECOND", kind: "add" });
    expect(rows[3].left.kind).toBe("pad");
    expect(rows[3].right).toEqual({ no: 4, text: "fourth", kind: "add" });
    expect(rows[4].left.no).toBe(4);
    expect(rows[4].right.no).toBe(5);
  });

  it("numbers from the hunk's own start on each side", () => {
    const rows = pairLines(
      [
        { kind: "ctx", text: "k" },
        { kind: "del", text: "g" },
        { kind: "add", text: "h" },
      ],
      20,
      21,
    );
    expect(rows[0].left.no).toBe(20);
    expect(rows[0].right.no).toBe(21);
    expect(rows[1].left.no).toBe(21);
    expect(rows[1].right.no).toBe(22);
  });

  it("returns nothing for empty input and does not throw on junk", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("not a diff\nat all")).toEqual([]);
  });
});
