// Item 947: the phone's Jobs list (JobsSheet) with Home's rows under fresh / stale / missing usage readings, on the phone's
// own tokens. Not shipped. Held for the browser pane or bin/snap.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, flushSync } from "svelte";
import remoteSrc from "../src/remote/Remote.svelte?raw";
import JobsSheet from "../src/remote/JobsSheet.svelte";
import { applyLook } from "../src/remote/look";
import type { Job } from "../src/remote/jobs";

{
  const out: string[] = [];
  const lines = remoteSrc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*:global\(((?::root|html, body).*)\)\s*\{\s*$/.exec(lines[i]);
    if (!m) continue;
    const body: string[] = [];
    for (i++; i < lines.length && !/^\s*\}\s*$/.test(lines[i]); i++) body.push(lines[i]);
    out.push(`${m[1]} {\n${body.join("\n")}\n}`);
  }
  document.head.insertAdjacentHTML("beforeend", `<style>${out.join("\n")}\nhtml,body{margin:0;background:var(--paper);font-family:var(--sans)}*,*::before,*::after{animation:none!important;transition:none!important}</style>`);
}
const q = new URLSearchParams(location.search);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const base = { text: "x", read_only: true, project: null, chat: null, paused: false, running: null, week: { points: 0, runs: 0 }, runs: 1, tz: "America/Los_Angeles", approval: "ask" } as const;
const unread = q.get("unread") === "1";
const jobs: Job[] = [
  { ...base, id: "scan", title: "Home's morning scan", every_words: "every day at 8:00 AM", next_run: ahead(600), note: "skipped — the weekly window was at 91% at 7:55 AM (Claude Code's usage cache)", last: { started: ago(5), ended: ago(5), outcome: "skipped", summary: "skipped — the weekly window was at 91% at 7:55 AM (Claude Code's usage cache)", week_points: null, week_after: null, reading: { source: "cli-cache" } } },
  { ...base, id: "scan2", title: "Home's scan (no reading)", every_words: "every day at 8:00 AM", next_run: ahead(1440), note: unread ? "usage could not be read — Home's 80% stop was not checked" : null, last: { started: ago(60), ended: ago(58), outcome: "done", summary: "ok", week_points: null, week_after: null, reading: { source: "none" } } },
  { ...base, id: "stale", title: "Home's scan (stale)", every_words: "every day at 8:00 AM", next_run: ahead(1440), note: "skipped — usage could not be read (last reading 41 min old)", last: { started: ago(2), ended: ago(2), outcome: "skipped", summary: "skipped — usage could not be read (last reading 41 min old)", week_points: null, week_after: null, reading: { source: "cli-cache" } } },
  { ...base, id: "pace", title: "Home pace stop", every_words: "every hour", next_run: ahead(30), note: "skipped — at this pace the weekly window reaches 100% by 11:30 PM, 4 days before it resets (the forecast misses by 2.0 points on average)", last: { started: ago(5), ended: ago(5), outcome: "skipped", summary: "skipped — at this pace the weekly window reaches 100% by 11:30 PM, 4 days before it resets (the forecast misses by 2.0 points on average)", week_points: null, week_after: null } },
  { ...base, id: "other", title: "Check CI", every_words: "every hour", next_run: ahead(20), note: null, last: { started: ago(40), ended: ago(38), outcome: "done", summary: "2 red", week_points: 1, week_after: 41 } },
];
const api = {
  jobs: async () => ({ jobs, now: new Date().toISOString() }),
  homeToday: async () => ({ points: 0.3, cap: 1, stop: "the weekly window was at 91% at 7:55 AM (Claude Code's usage cache)" }),
  jobNew: async () => jobs[0],
  jobPatch: async () => jobs[0],
  jobRun: async () => jobs[0],
  jobDelete: async () => {},
};
applyLook("filament");
mount(JobsSheet, { target: document.getElementById("app")!, props: { api, onmade: () => {}, onopen: () => {} } as never });
flushSync();
