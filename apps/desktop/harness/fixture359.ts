// Item 359 — the shared fixture for today359 and pick359: a long study chat, questions and replies of varied length.
export const QS = [
  "why does my AVL rotate twice on this insert?",
  "ok and if the left child is itself left-heavy",
  "write the rebalance for erase too",
  "what does the hash map do when the load factor passes 0.75",
  "can you sketch the test cases for the priority queue? names only",
  "that rehash test is wrong, the keys move buckets",
  "explain the amortised cost of the rehash in plain words",
  "the grader says my iterator is invalid after erase. why",
];
const PARA = [
  "The insert lands in the right subtree of the left child, so a single right rotation would only move the imbalance across; the first rotation straightens the zig-zag and the second fixes the height.",
  "Concretely: rotate left at the child, then right at the node. Heights update bottom-up, child first, so the parent reads the child's new height.",
  "For erase the shape is the same but you walk back up the whole path, because one rotation can shorten the subtree and push the imbalance to the grandparent.",
  "A load factor of 0.75 means three keys for every four buckets. Past it, collisions rise fast enough that doubling the table and reinserting every key is cheaper than living with long chains.",
  "Each key is moved once per doubling, and doublings get rarer as the table grows, so averaged over all the inserts it is a constant amount of work each.",
];
/** Reply i: one to many paragraphs, so the ticks' widths differ. */
export const REPLY = (i: number) => {
  const k = [1, 4, 2, 9, 1, 3, 14, 2, 5, 1, 6, 2][i % 12];
  return Array.from({ length: k }, (_, j) => PARA[(i + j) % PARA.length]).join("\n\n");
};
