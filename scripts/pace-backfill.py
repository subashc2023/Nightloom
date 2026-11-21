#!/usr/bin/env python3
"""One-off import of older plan readings for the pace forecast (item 769).

Nightloom's usage hook put a line like
    Usage: this message 3% (no per-message budget) · 5-hour 41% · week 72% · context 120k
into every Claude Code chat it ran, as an `attachment` entry with a
timestamp. Those are account-wide plan readings from before the pace log
(`~/.nightloom/plan-readings.jsonl`) existed. This walks the transcripts
under ~/.claude/projects, keeps only those attachment lines (never a
quoted line in a reply, which may be stale), and writes them as
`plan-readings-import.jsonl` beside the log, which `pace.rs` reads with it.

Read-only over the transcripts. Usage:
    python3 -I scripts/pace-backfill.py [--days 120] [--out ~/.nightloom/plan-readings-import.jsonl]
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time

USAGE = re.compile(r"Usage: ([^\"\\\n]*)")
FIVE = re.compile(r"5-hour (\d+(?:\.\d+)?)%")
WEEK = re.compile(r"week (\d+(?:\.\d+)?)%")


def readings(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if "Usage: " not in line or "5-hour " not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "attachment":
                continue
            ts = d.get("timestamp")
            m = USAGE.search(line)
            if not ts or not m:
                continue
            body = m.group(1)
            f, w = FIVE.search(body), WEEK.search(body)
            if not f:
                continue
            try:
                t = int(dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
            except ValueError:
                continue
            out = {"t": t, "fh": float(f.group(1))}
            if w:
                out["sd"] = float(w.group(1))
            yield out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--out", default=os.path.expanduser("~/.nightloom/plan-readings-import.jsonl"))
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    a = ap.parse_args()
    cutoff = time.time() - a.days * 86400
    seen = {}
    files = 0
    for dirpath, _dirs, names in os.walk(a.root):
        for n in names:
            if not n.endswith(".jsonl"):
                continue
            p = os.path.join(dirpath, n)
            try:
                if os.path.getmtime(p) < cutoff:
                    continue
            except OSError:
                continue
            files += 1
            for r in readings(p):
                seen[r["t"]] = r
    rows = sorted(seen.values(), key=lambda r: r["t"])
    tmp = a.out + ".tmp"
    with open(tmp, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")
    os.replace(tmp, a.out)
    first = dt.datetime.fromtimestamp(rows[0]["t"] / 1000) if rows else None
    last = dt.datetime.fromtimestamp(rows[-1]["t"] / 1000) if rows else None
    print(f"{len(rows)} readings from {files} transcripts, {first} to {last} -> {a.out}")


if __name__ == "__main__":
    sys.exit(main())
