// Item 856: the source-text tests written before the Transcript twins shared
// `transcript/logic.svelte.ts` read one file that held both the script and
// the markup. This puts that file back together for them — the logic module
// as the script, the markup with its `T.` (the logic) dropped — so their
// assertions keep meaning what they meant. New tests should not lean on it:
// check structure (`twins.ts`) or behaviour instead (622: source-text tests
// make refactors costly).
export function asOneFile(component: string, logic: string, logicName = "T"): string {
  const open = '<script lang="ts">';
  const a = component.indexOf(open) + open.length;
  const b = component.indexOf("</script>");
  const markup = component.slice(b).replace(new RegExp(`\\b${logicName}\\.`, "g"), "");
  // The logic's closing `return { … }` lists its members for the looks;
  // the old single file had none of it, so it is left out.
  const cut = logic.lastIndexOf("\n  return {\n");
  return component.slice(0, a) + "\n" + component.slice(a, b) + (cut > 0 ? logic.slice(0, cut) : logic) + markup;
}
