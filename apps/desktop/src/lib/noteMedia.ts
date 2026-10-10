import type { FileTabData } from "./api";

/** How the note view draws a file that is not text (nightshift backlog
 *  307): a PDF as pages, an image as itself, anything else as a card with
 *  Open and Reveal. `label` names the kind in words. */
export interface NoteMediaShape {
  view: "pdf" | "image" | "card";
  label: string;
}

const LABELS: Record<string, string> = {
  pptx: "PowerPoint deck",
  ppt: "PowerPoint deck",
  key: "Keynote deck",
  docx: "Word document",
  doc: "Word document",
  xlsx: "Excel spreadsheet",
  xls: "Excel spreadsheet",
  zip: "Zip archive",
  heic: "HEIC image",
  tif: "TIFF image",
  tiff: "TIFF image",
  mp3: "Audio file",
  m4a: "Audio file",
  wav: "Audio file",
  mp4: "Video",
  mov: "Video",
};

export function noteMediaShape(file: Pick<FileTabData, "kind" | "path" | "data">): NoteMediaShape {
  const ext = (file.path.split("/").pop() ?? "").split(".").slice(1).pop()?.toLowerCase() ?? "";
  if (file.kind === "pdf" && file.data) return { view: "pdf", label: "PDF" };
  if (file.kind === "image" && file.data) return { view: "image", label: ext ? `${ext.toUpperCase()} image` : "Image" };
  if (file.kind === "pdf") return { view: "card", label: "PDF" };
  return { view: "card", label: LABELS[ext] ?? "Binary file" };
}
