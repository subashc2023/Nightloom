// Item 684 proof: the app's copy code (mathSelection) on a real WebKit selection.
import { mathSelection } from "../src/lib/mathCopy";
const sel = document.getSelection()!;
const show = (id: string, r: Range) => {
  sel.removeAllRanges();
  sel.addRange(r);
  document.getElementById(id)!.textContent = mathSelection(sel)?.text ?? "null";
};
const rows = document.querySelectorAll("tbody tr");
const a = document.createRange();
a.setStart(rows[1].querySelector("code")!.firstChild!, 0);
a.setEnd(rows[2].querySelector("code")!.firstChild!, 3);
show("a", a);
const b = document.createRange();
b.selectNodeContents(document.getElementById("reply")!);
show("b", b);
const c = document.createRange();
c.selectNodeContents(document.querySelector("p")!);
show("c", c);
sel.removeAllRanges();
