// Item 338 harness — frame numbers measured by the build, shown on the page beside
// any measured live. Two passes of `?measure=<treatment>` in headless WebKit (a
// WKWebView with occlusion detection off, so it paints at 60 Hz), 2026-10-11 ~1:40 PM.
export const MEASURED: { when: string; how: string; rows: unknown[] } = {
  when: "2026-10-11 in WebKit (two passes each)",
  how: "The ~5,000-word reply (1,510 deltas) at 2× through each text option, single column, thinking and tools on As now, on the build's Mac with other builds running. The two passes differ by up to 13 frames/s for the same option, so only gaps larger than that mean anything. 'render' is the real component re-rendering the whole reply each delta; 'layer' is the treatment's own cost.",
  rows: [
    {"text": "now", "words": 5063, "seconds": 56.48, "frames": 2670, "fps": 47.27, "p50": 17, "p95": 35, "max": 1718, "over33": 150, "over50": 74, "renderMs": 6599, "layerMs": 320, "deltas": 1510, "run": 1},
    {"text": "now", "words": 5063, "seconds": 56.52, "frames": 3215, "fps": 56.89, "p50": 17, "p95": 27, "max": 341, "over33": 80, "over50": 21, "renderMs": 6444, "layerMs": 357, "deltas": 1510, "run": 2},
    {"text": "fade", "words": 5063, "seconds": 56.48, "frames": 2568, "fps": 45.47, "p50": 17, "p95": 46, "max": 505, "over33": 258, "over50": 105, "renderMs": 6589, "layerMs": 614, "deltas": 1510, "run": 1},
    {"text": "fade", "words": 5063, "seconds": 56.48, "frames": 2680, "fps": 47.45, "p50": 17, "p95": 48, "max": 254, "over33": 291, "over50": 111, "renderMs": 6605, "layerMs": 657, "deltas": 1510, "run": 2},
    {"text": "shuttle", "words": 5063, "seconds": 56.51, "frames": 3011, "fps": 53.29, "p50": 17, "p95": 33, "max": 991, "over33": 146, "over50": 46, "renderMs": 7148, "layerMs": 700, "deltas": 1510, "run": 1},
    {"text": "shuttle", "words": 5063, "seconds": 56.54, "frames": 2906, "fps": 51.4, "p50": 17, "p95": 35, "max": 711, "over33": 157, "over50": 67, "renderMs": 6640, "layerMs": 681, "deltas": 1510, "run": 2},
    {"text": "paced", "words": 5063, "seconds": 56.5, "frames": 2009, "fps": 35.56, "p50": 18, "p95": 74, "max": 402, "over33": 474, "over50": 217, "renderMs": 6621, "layerMs": 694, "deltas": 1510, "run": 1},
    {"text": "paced", "words": 5063, "seconds": 56.49, "frames": 2207, "fps": 39.07, "p50": 19, "p95": 59, "max": 920, "over33": 506, "over50": 168, "renderMs": 6925, "layerMs": 706, "deltas": 1510, "run": 2},
    {"text": "cool", "words": 5063, "seconds": 56.49, "frames": 2952, "fps": 52.26, "p50": 17, "p95": 35, "max": 202, "over33": 181, "over50": 52, "renderMs": 6778, "layerMs": 880, "deltas": 1510, "run": 1},
    {"text": "cool", "words": 5063, "seconds": 56.76, "frames": 2214, "fps": 39.01, "p50": 19, "p95": 55, "max": 1043, "over33": 329, "over50": 130, "renderMs": 8049, "layerMs": 1038, "deltas": 1510, "run": 2},
  ],
};
