// The Stop button's shape (item 411): read once at start, set from
// Settings → Appearance, remembered in localStorage.
import { STOP_SHAPE_KEY, parseStopShape, type StopShape } from "./stopButton";

function load(): StopShape {
  try {
    return parseStopShape(localStorage.getItem(STOP_SHAPE_KEY));
  } catch {
    return "square";
  }
}

export const stopPref = $state({ shape: load() as StopShape });

export function setStopShape(s: StopShape): void {
  stopPref.shape = s;
  try {
    localStorage.setItem(STOP_SHAPE_KEY, s);
  } catch {
    // A shape that does not persist still applies for this run.
  }
}
