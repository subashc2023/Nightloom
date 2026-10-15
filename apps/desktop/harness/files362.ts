// Item 362 — the files the drop pages drop: an image drawn on a canvas (a tree diagram, so the thumbnail reads as
// a picture) and a PDF (a minimal valid header; only its name and type matter to the chip).
export async function pngFile(name = "avl-whiteboard.png"): Promise<File> {
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 240;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4efe4";
  g.fillRect(0, 0, 320, 240);
  const nodes: [number, number, string][] = [[160, 50, "41"], [90, 120, "20"], [230, 120, "65"], [50, 190, "11"], [130, 190, "29"], [270, 190, "72"]];
  g.strokeStyle = "#333";
  g.lineWidth = 3;
  for (const [a, b] of [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5]]) {
    g.beginPath();
    g.moveTo(nodes[a][0], nodes[a][1]);
    g.lineTo(nodes[b][0], nodes[b][1]);
    g.stroke();
  }
  for (const [x, y, l] of nodes) {
    g.fillStyle = l === "29" ? "#e0a458" : "#fff";
    g.beginPath();
    g.arc(x, y, 24, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = "#222";
    g.font = "bold 20px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(l, x, y + 1);
  }
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
  return new File([blob], name, { type: "image/png" });
}
export const pngDataUrl = async () => {
  const f = await pngFile();
  return await new Promise<string>((r) => {
    const fr = new FileReader();
    fr.onload = () => r(String(fr.result));
    fr.readAsDataURL(f);
  });
};
export function pdfFile(name: string): File {
  return new File(["%PDF-1.4\n%âãÏÓ\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"], name, { type: "application/pdf" });
}
