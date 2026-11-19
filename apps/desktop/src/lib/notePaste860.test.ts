import { describe, expect, it } from "vitest";
import { extFor, noteStem, planFilePaste, planNotePaste, saveNotePasteImages, slugWords } from "./notePaste";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("item 860: paste text with images into a note", () => {
  it("puts a relative link where each image stood, named for a model to choose by", () => {
    const html = `<h2>ALU</h2><p>The truth table:</p><img src="${PNG}" alt="ALU truth table"><p>Then the adder.</p>
      <figure><img src="https://canvas.example/files/9/adder.jpeg?x=1"><figcaption>Ripple-carry adder</figcaption></figure>
      <p>More</p><img src="https://x.example/a">`;
    const plan = planNotePaste(html, "Exams/Lecture 3.md")!;
    expect(plan.folder).toBe("Exams/attachments");
    expect(plan.images.map((i) => i.file)).toEqual([
      "lecture-3-01-alu-truth-table.png",
      "lecture-3-02-ripple-carry-adder.jpg",
      "lecture-3-03-alu.png",
    ]);
    expect(plan.text).toContain("## ALU");
    expect(plan.text).toContain("The truth table:\n\n![ALU truth table](attachments/lecture-3-01-alu-truth-table.png)");
    expect(plan.text).toContain("![Ripple-carry adder](attachments/lecture-3-02-ripple-carry-adder.jpg)");
    expect(plan.text.indexOf("Then the adder")).toBeLessThan(plan.text.indexOf("lecture-3-02"));
    expect(plan.text).not.toContain("\u0000");
  });

  it("a note at the store's top level links attachments/ beside it; no image, no plan", () => {
    const plan = planNotePaste(`<p>a</p><img src="${PNG}">`, "new note.md")!;
    expect(plan.folder).toBe("attachments");
    expect(plan.text).toBe("a\n\n![image 1](attachments/new-note-01.png)");
    expect(planNotePaste(`<p>see <img src="${PNG}"> here</p>`, "n.md")!.text).toBe("see ![image 1](attachments/n-01.png) here");
    expect(planNotePaste("<p>just text</p>", "n.md")).toBeNull();
    expect(planNotePaste(`<img src="${PNG}" width="1" height="1">`, "n.md")).toBeNull();
  });

  it("dozens of images keep their order and a fixed-width index", () => {
    const html = Array.from({ length: 120 }, (_, i) => `<p>q${i}</p><img src="${PNG}" alt="fig ${i}">`).join("");
    const plan = planNotePaste(html, "n.md")!;
    expect(plan.images).toHaveLength(120);
    expect(plan.images[0].file).toBe("n-001-fig-0.png");
    expect(plan.images[119].file).toBe("n-120-fig-119.png");
  });

  it("names and extensions", () => {
    expect(slugWords("Ünïcode — Truth/Table (v2)!")).toBe("unicode-truth-table-v2");
    expect(noteStem("a/b/My Note.md")).toBe("my-note");
    expect(extFor("data:image/webp;base64,xx")).toBe("webp");
    expect(extFor("https://h/p/x.JPEG#f")).toBe("jpg");
    expect(extFor("https://h.png/p/x")).toBe("png");
    expect(planFilePaste([{ name: "Screenshot 1.png", src: PNG }], "n.md").text).toBe(
      "![Screenshot 1](attachments/n-01-screenshot-1.png)",
    );
  });

  it("saves each image; a clash moves its link, a failure says why in its place", async () => {
    const html = `<img src="${PNG}" alt="one"><img src="https://h/two.png" alt="two"><img src="blob:x" alt="three">`;
    const plan = planNotePaste(html, "n.md")!;
    let text = plan.text;
    const kept: string[] = [];
    const res = await saveNotePasteImages(plan, "n.md", {
      fetch: async () => ({ media_type: "image/jpeg", data: "AAAA" }),
      keep: async (folder, file) => {
        kept.push(`${folder}/${file}`);
        return file.startsWith("n-01") ? `${folder}/n-01-one (2).png` : `${folder}/${file}`;
      },
      relink: (from, to) => {
        text = text.replace(from, to);
      },
    });
    expect(res).toEqual({ saved: 2, failed: 1 });
    expect(kept).toEqual(["attachments/n-01-one.png", "attachments/n-02-two.jpg"]);
    expect(text).toContain("![one](attachments/n-01-one%20%282%29.png)");
    expect(text).toContain("![two](attachments/n-02-two.jpg)");
    expect(text).toContain("[image: could not be fetched (the page kept it to itself");
  });
});
