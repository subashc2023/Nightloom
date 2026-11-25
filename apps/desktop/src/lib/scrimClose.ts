/**
 * Item 927: a click outside a dialog is its Cancel. Put on the dialog's
 * scrim (the dimmed layer around it, or a sibling layer under it):
 * `use:scrimClose={cancel}`. The press and the release must both land on
 * the scrim itself — a drag that starts inside the dialog (selecting text,
 * a slider, a half-typed field) and ends outside it never cancels, which a
 * bare `onclick` with `target === currentTarget` did (the click of a drag
 * goes to the nearest common ancestor: the scrim).
 */
export function scrimClose(node: HTMLElement, close: () => void) {
  let fn = close;
  let downHere = false;
  const down = (e: PointerEvent | MouseEvent) => {
    downHere = e.target === node;
  };
  const click = (e: MouseEvent) => {
    const go = downHere && e.target === node;
    downHere = false;
    if (go) fn();
  };
  node.addEventListener("pointerdown", down);
  node.addEventListener("mousedown", down);
  node.addEventListener("click", click);
  return {
    update(next: () => void) {
      fn = next;
    },
    destroy() {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("mousedown", down);
      node.removeEventListener("click", click);
    },
  };
}
