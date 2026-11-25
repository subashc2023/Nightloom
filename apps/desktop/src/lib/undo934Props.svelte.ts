/** Tests (item 934's review): a component's props as one `$state` object, so a test can change two props in
 *  one flush, as a parent's state does. */
export function liveProps<T extends object>(init: T): T {
  const props = $state(init);
  return props;
}
