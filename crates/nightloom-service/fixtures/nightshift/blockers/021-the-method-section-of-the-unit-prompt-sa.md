---
id: "021"
status: open
raised: 2026-09-09
shift: ""
item: ""
---

## Question

The METHOD section of the unit prompt says "You can read PDFs with `pdftotext`" — but a unit has no way to *fetch* a PDF, so the instruction is unfollowable. Should the runner grant `Bash(curl:*)` (or a narrower `Bash(curl -sL -o /tmp/...:*)`), or should the prompt stop recommending PDFs?

## What I would have done, and why

**Grant a narrow curl.** The prompt's own
METHOD section says a claim resting on this repo's fetch instrument is weaker than
one resting on the text, and cites two false absences and one false PRESENT
(backlog item 32) as the reason. Right now `WebFetch`-through-a-summariser is the
*only* instrument a unit has, so every source in every note is read through the
weak one. `curl` + `pdftotext` is the fix the prompt already names. I did not
choose between the wildcard and the narrow form because the same judgement is
already sitting open under blocker #20 ("exact-argv allowlisting IS supported …
narrowing it is a separate judgement") and it is yours, not mine.

**Evidence, `inferred` from this session (2026-09-09, slot-4 unit):** four
`curl -sL -o <scratchpad>/x.pdf https://arxiv.org/pdf/...` calls, all four
"requires approval … denied". Also denied: `cd notes/ace && grep …` — the
`cd X && …` shape, which is the same unanalysable-command class item 13 records
for pipes. Both are recorded in `notes/value-generalization/breadth-q4.md`
("Instrument notes for the runner").

**ADDENDUM 2026-09-09 (slot-5 unit) — A WORKAROUND EXISTS; THE QUESTION IS NOW
LOWER-STAKES, NOT CLOSED.** `curl` is still denied (re-tested once this session,
denied identically). ~~"no unit can currently satisfy the prompt's own standard"~~
— **SUPERSEDED: units can.** `WebFetch` on a PDF URL writes the PDF to disk of its
own accord and prints the path (`[Binary content (application/pdf, …) also saved
to …/tool-results/webfetch-<id>.pdf]`); `pdftotext -layout <path> <out.txt>` is
**permitted and works**. Four papers were read this way in
`notes/value-generalization/breadth-q5.md`, and it caught one summariser error the
unit would otherwise have recorded as a finding. Still denied: `cd X && …`, and
compound commands mixing an absolute path with a relative-path read. **The
decision is still yours** — this does not make `curl` unnecessary (WebFetch only
saves PDFs it is pointed at, and non-PDF sources still come through the
summariser), it just means no unit should report the instruction as unfollowable.

## What it blocks

nothing outright — this unit read five papers via `ar5iv`,
`arxiv.org/abs` and a PMC mirror and got verbatim quotes from all of them. It
blocks *evidence quality*, uniformly and invisibly, for every unit: no unit can
currently satisfy the prompt's own standard of checking a claim against the source
text rather than a summariser's report of it.

## Answer
