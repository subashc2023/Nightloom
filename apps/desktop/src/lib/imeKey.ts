/**
 * A key the input method (IME: Japanese or Chinese entry, the accent popup
 * a held key opens) is holding — item 322. While a composition is open,
 * Enter commits the marked text; it must not also send the message. A
 * second Enter, after the commit, is an ordinary key and sends.
 *
 * Two signals, because WebKit (the engine of the app's window) sends them
 * in a different order from Chromium: Chromium's commit-Enter arrives with
 * `isComposing` true before `compositionend`; Safari / WebKit fires
 * `compositionend` first and then the Enter keydown with `isComposing`
 * false but `keyCode` 229 ("Process"). Either one means the key is the
 * input method's.
 */
export interface ImeKeyLike {
  isComposing?: boolean;
  keyCode?: number;
}

export function isImeKey(e: ImeKeyLike): boolean {
  return !!e.isComposing || e.keyCode === 229;
}
