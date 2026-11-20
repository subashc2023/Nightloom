#!/bin/sh
# Item 853 (fix 2): the type-to-focus check over the real App with real AppKit clicks and keys (snapkeys: WebKit,
# activation .prohibited, never ordered front, never takes focus).
#   harness/type853/check.sh <out-dir>     (from apps/desktop; builds, compiles snapkeys, runs every case)
# One row per case; exits 1 if any typed "h" missed the box meant (or a page error showed).
set -u
OUT=${1:?out dir}
cd "$(dirname "$0")/../.." || exit 2
mkdir -p "$OUT" && xattr -w com.apple.fileprovider.ignore#P 1 "$OUT" 2>/dev/null
H9_DEBUG=1 nice -n 15 npx vite build -c harness/type853/vite.config.ts --outDir "$OUT/dist" > "$OUT/build.log" 2>&1 || { echo "build failed: $OUT/build.log"; exit 2; }
sed -i '' -e 's/ type="module" crossorigin/ defer/' -e 's/ crossorigin//' "$OUT/dist/type853.html"
[ -x "$OUT/snapkeys" ] || nice -n 15 swiftc -O harness/type853/snapkeys.swift -o "$OUT/snapkeys" || exit 2
for f in 1 0; do for c in 0 1; do for pre in $( [ $f = 1 ] && echo "box main card cardbox body tab" || echo "box main" ); do
  for sc in main main-with-card main-with-anchor main-topbar card-thread card-head card-border anchor-thread anchor-head anchor-border anchor-finish panel-thread tab-thread tab-head tab-switch main-scroll card-scroll anchor-scroll panel-scroll; do
    p=$pre; [ "$p" = box ] && p=
    "$OUT/snapkeys" "$OUT/dist/type853.html#sc=$sc&classic=$c&format=$f&real=1&pre=$p" 1280 800 40
  done
done; done; done | python3 -c '
import sys, json
bad = n = 0
for l in sys.stdin:
    try: d = json.loads(l)
    except Exception: print("ERR", l.strip()); bad += 1; continue
    n += 1
    want = "main" if d["sc"].startswith("main") else "aside"
    got = [k for k in ("main", "aside") if d[k + "Box"].replace("cm:", "") == "h"]
    ok = got == [want] and not d["errs"]
    bad += not ok
    print("ok  " if ok else "FAIL", d["sc"].ljust(17), "classic" if d["classic"] else "jarvis ", ("formatted" if "cm-" in d["before"] or d["mainBox"].startswith("cm:") else "plain    "), "focus-before=" + d["before"].split(".")[0][:12].ljust(12), "->", ",".join(got) or "nowhere", d["errs"] or "")
print(f"{n - bad}/{n} ok")
sys.exit(1 if bad else 0)'
