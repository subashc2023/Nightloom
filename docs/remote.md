# Remote — Nightloom on your phone over the tailnet

Nightshift backlog 091, Shape B (2026-09-16); rewritten from the code on
2026-11-26 (item 1015, after the Simulator audit of item 740). A small HTTP(S)
server inside the desktop process serves a phone-width page. The turn still
runs on the Mac; the phone is a window onto it. His wish list (blocker 104,
in his words): "see what it's doing, answer the permission prompts, send it
the next thing, from my phone, without a public server".

Every section names the file it was read from. Line numbers are as of
`7921bd89` and drift; the file names do not.

## What the phone page does

Source: `apps/desktop/src/remote/Remote.svelte` (the page), its components
beside it, and `apps/desktop/remote.html` (the entry).

- **Pairing and hosts.** The page pairs by a link ending `#token=<hex>`; it
  keeps the token in local storage and strips it from the address bar
  (`client.ts:44`). The header's **host chip** opens the **Hosts** sheet
  (`Hosts.svelte`): two hosts, the **Mac** and **Away** (the away server, a
  copy of the service on Fly; `nightloom serve`, `Server::start_public`, `mod.rs:771`), each
  with its own token — "The page tries the Mac first, then Away"
  (`Hosts.svelte:112`). Per host: Pair / Pair again, Forget. A wrong token
  shows a "scan again" bar; an unreachable Mac shows an offline bar, and
  **Send** becomes **Hold** (see below). The Hosts sheet also holds the
  **Speech test** button (`Remote.svelte:4402`).
- **Home** (`HomeFirst.svelte`, `HomeStage.svelte`; first screen when the
  address names no place): the Needs-you count, Watching / brief tabs, the
  Handled corner (Mark all seen), Running, a "Tell Home…" box, the Jobs row.
  Details in "Home, the phone's first screen" below.
- **The drawer** (`Remote.svelte:4001–4137`), top to bottom: **Home**, close,
  a search box with scopes (This project / All chats / Notes; hits show a
  highlighted snippet), **New chat**, **Projects**, **Running tasks**,
  **Jobs**, **Notes**, **Nightshift**, **Send feedback**, **Dream**,
  **Capture**, then **Recents** (pull to refresh), the usage line
  (`UsageLine.svelte`: 5-hour and week figures) and a footer saying which host
  answers. Rows for features the host lacks are hidden (`hasFeature`).
- **A chat**: the transcript with tool calls as one-line rows; a composer
  with Send / **Hold** / Stop, photos and documents, a model pill, a mic
  (`voice/MicButton.svelte`); cards for approvals, questions, plans, secrets
  (`SecretAsk.svelte`, with the Bitwarden picker) and job approvals
  (`JobChatCard.svelte`, `JobApproval.svelte`); a **Changes** sheet per turn
  (`ChangesSheet.svelte`); a message menu (`MessageMenu.svelte`); a context
  row (cache chip, 5-hour share, next-turn cost) that opens the **Context**
  sheet and its layer editor (`ContextSheet.svelte`, `LayerEditor.svelte`).
- **The chat's ⋯ menu** (`ChatMenu.svelte`): Rename, **Model and settings**,
  New chat in project, then under More: Contents (only when the chat has
  chapters), **Ask aside** (`AsideSheet.svelte`), **Ask the council**
  (`CouncilSheet.svelte`), Continue, Make it a plain chat, Compact, Context,
  Tool calls (show all / fewer), **Approval rules** (`RulesSheet.svelte`),
  Open on the Mac, and Delete (moves to the trash; **Restore** brings it back).
- **Model and settings** (`RailSheet.svelte`, route `/api/rail`): Model,
  Effort, Thinking, and under Advanced a Fallback model, Approvals
  (Auto / Ask / Plan), Fork helpers, Subagent limits and the model they run
  on, the Council's seats and mode (answer / disproof), then **Look on this
  phone** (Jarvis / Classic) and, under it, the **Notifications on this phone**
  row (`PushRow.svelte`, mounted at `Remote.svelte:4299–4302`; this is not a
  "Settings" sheet).
- **Sheets from the drawer**: Projects and a project page (`ProjectsSheet.svelte`,
  `ProjectPage.svelte`; New project, rename, forget), Notes (`NotesSheet.svelte`:
  the project's notes and the vault), Nightshift (`NightshiftSheet.svelte`:
  queue, blockers with an Answer box, mornings, Add item), Jobs
  (`JobsSheet.svelte`), Running (`RunningSheet.svelte`), Send feedback
  (`FeedbackSheet.svelte`).
- **Held messages** survive closing the page; an unreachable Mac or a running
  turn turns Send into Hold (see "Setting it up", step 6).

## How a message travels

Routes are in "Routes" below. A message or an answer from the phone is not
run in Rust: it is handed to the desktop window as a `remote-send` /
`remote-approve` / `remote-cancel` event, and the window's own `send`,
`resolveApproval` and `cancelTurn` run it. The three listeners are in
`apps/desktop/src/lib/remoteHandlers.ts:988–1008` (not `state.svelte.ts`).
So the transcript, the composer's queue, the hand-off, the banner and the
sleep watch all see a phone message exactly as a typed one. The window
answers through the `remote_sent` command (`remote.rs:2065`); a window that
does not answer within `SEND_WAIT` = 3 s (`remote.rs:87`) is a 409.

## Routes

Source: `crates/nightloom-service/src/remote/mod.rs`, `fn router` (about
lines 900–1000), plus the merged routers named in the right column. The
listener has one address and port (default `8642`, `DEFAULT_PORT`,
`mod.rs:80`, blocker 172).

**Served without the bearer token** (the outer router, `mod.rs:983–998`):

| Route | What |
|---|---|
| `GET /`, `GET /remote.html` | the page |
| `GET /assets/{*path}`, `GET /remote/{*path}` | the page's files only; the desktop's own `index.html` is a 404 (`serve_asset`, `mod.rs:1986`) |
| `GET /apple-touch-icon.png`, `…-precomposed.png` | Home Screen icon |
| `GET /push-sw.js` | the push service worker (holds no token) |
| `GET /api/voice` | WebSocket; the **first frame carries the token**, checked before any audio is read (`voice_ws.rs`) |

**Everything else is under `/api` with `Authorization: Bearer <token>`**; a
missing or wrong one, and every unknown path, is a 401 with the sentence "the
token is missing or wrong — open the link from Settings → Remote again"
(`require_token`, `mod.rs:1085`; the fallback sits inside the layer on
purpose, so a missing route cannot be told from a real one without a token).
About 90 routes:

| Group | Routes | Defined in |
|---|---|---|
| State and chats | `GET /state`, `GET /chats`, `POST /new`, `POST /chats/{id}/rename`, `/open`, `GET /chats/{id}/transcript`, `/context` (also `POST`), `POST /chats/{id}/act`, `/media`, `/layers`, `/cancel`, `POST /cancel` | `mod.rs` |
| Send | `POST /chats/{id}/send`, `POST /send` — body `SendRequest` (`mod.rs:188–202`): `text`, `spoken`, `project`, `images`, `documents`, `council`; the 202 body is `{"status":"sent"}` or `{"status":"queued"}`, a refusal is a 409 | `mod.rs` |
| Approvals, secrets | `POST /approve` (`allow` / `always` / `deny` / `later`, question answers, plan approval), `POST /secret`, `GET /bitwarden/ready`, `POST /bitwarden/search`, `/bitwarden/store` | `mod.rs` |
| Stream | `GET /events` — SSE: `hello`, then the desktop's `turn-event`, `tool-approval`, `turn-notice` by name with payloads unchanged, `lagged` when the phone fell behind, a comment every 15 s | `mod.rs` |
| Projects | `GET`/`POST /projects`, `POST /projects/{id}/open`, `/rename`, `/forget`, `GET /projects/{id}/chats`, `GET /projects/{pid}/chats/{id}/transcript` | `mod.rs` |
| Asides, settings, status | `POST /chats/{id}/aside`, `/aside/cancel`, `GET /chats/{id}/asides`, `GET`/`POST /rail`, `GET /running`, `/usage`, `/cache-rates`, `/search` | `mod.rs` |
| Notes, passes, files, voice | `GET /notes`, `GET`/`PUT`/`DELETE /notes/{scope}/{*name}`, `POST /dream`, `POST /capture`, `GET /sent-files/{id}/{name}`, `POST /listen`, `/listen/brief` | `mod.rs` |
| Nightshift | `GET /nightshift`, `/nightshift/{p}/queue`, `POST …/items`, `GET …/items/{id}`, `…/blockers`, `…/blockers/{id}`, `POST …/blockers/{id}/answer`, `GET …/mornings`, `…/mornings/{name}` | `nightshift_routes.rs:185–193` |
| Feedback | `/feedback` | `feedback_routes.rs:49` |
| Home's sources | `GET /home/sources`, `POST /home/sources/{id}/ask`, `GET /home/routes`, `POST /home/routes/{id}/start`, `/dismiss` | `home_routes.rs:35–39` |
| Home's screen | `GET /home/feed`, `POST /home/seen`, `GET /home/scan`, `/home/held`, `/home/today`, `/home/tasks`, `POST /home/tasks/event`, `/home/tasks/{id}/close`, `/home/tasks/focus`, `GET /home/steps`, `GET /shortcut/needs` | `home_phone_routes.rs:39–49` |
| Push | `GET /push`, `POST /push/subscribe`, `/unsubscribe`, `/seen`, `GET /push/feed`, `POST /push/test`, `/push/key` | `push_routes.rs:37–43` |
| Rules | `GET`/`POST /rules`, `GET`/`PUT /sync/rules` | `rules_routes.rs:39–40` |
| Saved prompts | `GET /saved-prompts` | `saved_prompt_routes.rs:20` |
| Jobs | `GET`/`POST /jobs`, `POST`/`DELETE /jobs/{id}`, `POST /jobs/{id}/run` | `job_routes.rs:35–37` |
| Shortcuts | `POST /shortcut/send`, `GET /shortcut/running` | `shortcut_routes.rs:38–39` |
| Sync (Mac ↔ away server) | `/sync/manifest`, `/sync/files/{*path}`, `/sync/outbox` (+ `/{chat}/log`, `/cli`), `/sync/ack`, `/sync/lease`, `/sync/jobs` | `sync_routes.rs:51–65` |

Which route groups a host serves is told by `Host::features` (`mod.rs:496`,
sent on `/api/state`, with `kind`: `mac` or `serve`, `mod.rs:503`): the page
hides or greys a surface when its feature is missing, and a route answers 501
when the host has none (`refused`, `mod.rs:1110`).

## The binding rule

**The listener binds the Mac's Tailscale address and nothing else** —
never `0.0.0.0`, never a LAN address, and there is no option for either
(blocker 105, its default taken). The address comes from `Tailscale ip -4`
(the app's bundled CLI, then `tailscale` on PATH), else from `ifconfig`'s
`100.64.0.0/10` line (`tailnet.rs`); `Server::start` refuses any address
outside that range before a socket exists (`mod.rs:745`, `Error::NotTailnet`).
With Tailscale off the switch fails with a sentence naming it. While the
listener is on, the card and the QR show the address it is *bound* to, not
whatever Tailscale answers now: if the node's address changes (a re-login, a
reset), switch Remote off and on to bind the new one. (The away server is the
one exception: `start_public` binds any address, plain HTTP, behind Fly's proxy,
`mod.rs:765–771`.)

**TLS.** Plain HTTP by default: the tailnet is WireGuard end to end, and a
certificate the phone would have to trust is a setup step this page exists to
not have. **HTTPS is served when `cert.pem` and `key.pem` (from `tailscale
cert`) are in `<config>/remote/`** (`tls.rs:13,43`; `mod.rs:750–761`; the
phone's microphone needs a secure page). Unreadable files are an error, not a
silent fall back to HTTP. The app renews the certificate at each start when
HTTPS is already set up (`remote.rs:2283–2305`, `renew_certificate`), and the
running listener renews it daily (`tls::keep_fresh`, `mod.rs:829`). The
certificate is for the machine's tailnet **name**, not its address, so the QR
carries `https://<machine>.<tailnet>.ts.net:<port>/#token=…`
(`https_setup_url`, `remote.rs:1997`). Only devices on *your* tailnet can
reach the port at all; the token is what stops another of them.

## The token

Source: `credentials.rs:316–400`, `remote/token.rs`, `remote.rs:2407` (the
`remote_token` command), `client.ts:44`.

**Where it comes from**, decided by `remote_token_source`
(`credentials.rs:343`) in this order:

1. **`NIGHTLOOM_REMOTE_TOKEN`** (item 1003, blocker 2333), if set and not
   blank (it is trimmed): used as is, stored nowhere. **Regenerate is refused**
   under it ("the phone token comes from NIGHTLOOM_REMOTE_TOKEN; change it
   there", `Error::FromEnv`).
2. **A set `NIGHTLOOM_HOME` without it**: *no token at all*, and the listener
   refuses to start ("this is a dev home (NIGHTLOOM_HOME is set): the phone
   page needs NIGHTLOOM_REMOTE_TOKEN here, and the keychain's real token is
   never used", `Error::DevHome`; checked at `remote.rs:2265`). A dev app never
   serves under the installed app's token.
3. **Otherwise the keychain** (`remote:token`, beside the API keys), made once
   when the listener first goes on: one uuid v4's random bits as 32 lowercase
   hex characters (`token.rs:17`, blocker 173). Never on disk.

**Use a hex token.** The page's `#token=` reader accepts only
`[0-9a-fA-F]{16,128}` and lowercases it (`client.ts:45`). A non-hex
`NIGHTLOOM_REMOTE_TOKEN` is served by the listener but can never be paired
from a link (the audit's first token, url-safe base64, did exactly this;
measured in item 740, row 1). Nothing warns about it yet.

Every `/api` call carries it as `Authorization: Bearer …`; a wrong one is a
401 (the page then says "scan again"). The page and its files need none — the
page is not secret.

It reaches the phone through the page's own URL: the QR in Settings →
Remote encodes the HTTPS link above when HTTPS is set up, else
`http://<address>:<port>/#token=<token>`. The token rides the fragment, which
never leaves the browser — not in a request, not in a referer — and the page
moves it into local storage and strips it from the address bar the moment it
loads. The event stream is read with `fetch` rather than `EventSource` for the
same reason: `EventSource` cannot send a header, and the token must not go in
a URL. (A pairing link for the away server and the Mac together is
`<away>/#token=…&mac=…&mt=…`, `remote.rs:1980`.)

**Regenerate** (in the card, `SettingsModal.svelte:2826`) replaces the token
and restarts a running listener with it; every phone must scan again. Off,
and a restart, end every open event stream at once — a phone holding one is
cut, not left listening with the old token.

### What the phone is told (backlog 132, 2026-09-17)

A send from the phone used to be answered 202 the moment the listener had
handed it to the desktop window — and a message the window then could not
send (no engine connected, the desktop busy in *another* chat, a chat id
that would not open) was dropped with the phone told it was taken. Now the
window answers: the 202's body is `{"status":"sent"}` (the turn starts)
or `{"status":"queued"}` (the open chat is mid-turn; the message is in its
composer queue on the Mac and goes when that turn ends — the phone says
so and draws the row when it lands), and a refusal is a **409** with the
sentence, on which the phone keeps the text and, when the Mac is idle
again, sends it from its own queue. A window that does not answer within
3 s is a 409 too. The desktop side: `remote-send` carries an id; the
window's `remoteSend` reports through `remote_sent`.

Three smaller fixes from the same review: a keychain that *could not be
read* (locked, a denied prompt after a re-signed build) no longer reads as
"no token" — the listener's start and Regenerate refuse with a sentence
and keep the token, so the phones stay paired (`try_remote_token`); the
Tailscale CLI is waited for at most 2 s and the card's reads run off the
runtime, so a hung daemon cannot stall a streaming turn; and a rebind that
fails no longer leaves remote off — on a new port the new listener binds
before the old one stops, on the same port the old address and token are
brought back, and Regenerate stores the new token only once the listener
runs with it. The URL under the QR shows `#token=…` until *Show the
token*.

## Setting it up on the phone

1. On the Mac: Tailscale open and signed in. Settings (⌘,) → **Remote** →
   switch **On**. The card shows the bound address and port (read-only),
   a QR code, and the token as text (Show).
2. On the iPhone: Tailscale open and connected. Camera → point at the QR →
   tap the link → Safari opens the QR's address (`https://<machine>.<tailnet>.ts.net:8642/`
   with HTTPS, else `http://100.x.y.z:8642/`). The chat list of
   the open project appears, the open chat marked. The address bar no
   longer shows `#token`.
3. Share → **Add to Home Screen** → open it from there: full screen, no
   Safari chrome, the Nightloom icon. (Without the QR: open the address in
   Safari and paste the token into the field on the first screen.)
   *Unmeasured (review 2026-09-17 FA11, backlog 132):* a home-screen web
   app on iOS runs in its own storage, and the page has already dropped
   `#token` from the address by the time it is bookmarked — so the
   home-screen copy may open to the paste field the first time. If it
   does: Settings → Remote → **Show the token**, and paste it once; it is
   kept from then on. Say so if you see it and the page will keep the
   fragment until after the install instead.
4. Tap a chat: its transcript, tool calls as one-line rows under the reply
   that made them. Type, Send: the message shows at once and the reply
   streams. **Stop** ends the turn.
5. A permission prompt, a question, or a plan on the Mac appears as a card
   on the phone under the running turn: Allow · Allow for this chat · Deny
   (with a note as the reason), the question's options and an Other
   field, Approve · Keep planning with ask/auto after. Answering on either
   device clears both.
6. With the Mac unreachable (Wi-Fi off, Tailscale off, the listener off)
   or a turn already running, Send becomes **Hold**: the message waits in a
   strip above the composer with a take-back (×), survives the page being
   closed, and goes when the Mac is reachable and idle — oldest first, one
   per turn.

## Keep the Mac awake while remote is on

The card's switch holds the app's keep-awake guard (the Sleep card's
`caffeinate` assertion, backlog 101) for as long as the listener is on.
It spawns the assertion only when the Sleep card's own "keep the Mac
awake while a turn runs" switch is on — the holder's rule, unchanged
(blocker 175). A closed lid on battery still sleeps the Mac either way.

## Push notifications (item 739, 2026-11-16)

The Home Screen app can be sent real pushes (iOS 16.4+; the HTTPS link).
Model and settings sheet → **Notifications on this phone**
(under Look; `Remote.svelte:4299–4302`) is the Subscribe switch,
its off switch and "Send a test notification"; in Safari, or on the plain
HTTP link, the row says why it cannot be turned on.

- A push says the chat's name and its state — Finished, Failed, Paused by
  the usage limit, Waiting for your approval, Has a question for you — and
  nothing of the reply (blocker 2011). A tap opens that chat; the icon's
  badge is the number of chats waiting on him.
- None is sent while the Mac's keyboard or trackpad was touched in the last
  two minutes. The away server cannot know that and always sends.
- Routes, all behind the bearer: `GET /api/push`, `POST /api/push/subscribe`,
  `/unsubscribe`, `/seen`, `GET /api/push/feed` (what needs him; Home reads it,
  `push_routes.rs:41`), `/test`, and `/key` (away server only). The
  worker is `/push-sw.js` (no fetch handler, no cache, no token).
- Files, per host, mode 0600 under `<home>/remote/push/`: `vapid.pk8` (the
  signing key, made once) and `subscriptions.json`. The Mac's sync pass
  hands its key to the away server so both sign with one — a phone holds
  one subscription, tied to one key. An optional `subject` file holds the
  VAPID contact (`mailto:` or `https:`); the default names nobody.
- Code: `crates/nightloom-service/src/push/` (crypto on `ring`, store,
  sender), `remote/push_routes.rs`, `src/remote/push.ts`, `PushRow.svelte`,
  `public/remote/push-sw.js`; the Mac's triggers are `notify.ts` →
  the `push_note` command, the away server's are in `serve.rs`.

## Recurring jobs (item 746, 2026-11-16)

A job repeats one message on a schedule in its own chat. Make one from the
drawer → **Jobs** → New job, or type "repeat every morning: check CI and
tell me what failed" in any chat (the form opens filled; nothing is sent).

- The list shows each job's schedule, next run (12-hour, on the phone's
  clock when it was saved), last result with the reply's first lines, and
  what the run cost of the weekly limit. Pause / Resume and Run now act at
  once; Delete asks first and moves the job to `trash.json` (its chat stays).
- **Read-only until he approves its plan.** The job's chat is a Claude Code
  chat held to the Chat policy (reads, search, the web; no shell, no file
  edits, no subagents). "Approve its plan…" lets later runs write; changing
  the message takes the approval back. On the Mac the policy is set on the
  chat's log, on the spec its run is made from (`agents.rs`
  `reserve_for_job`), and again at the turn's start from the log
  (`hold_to_kind_policy` in `send_agent`), so no other connection's spec can
  run it with the writers.
- A run is a turn like any other: item 739's push says "<job> — Finished".
- The Mac runs a job only while the phone listener is on, on the Claude
  Code engine, with the job's project open; otherwise the row says
  "Waiting — …" and it retries each minute.
- Routes, behind the bearer: `GET/POST /api/jobs`, `POST/DELETE
  /api/jobs/{id}`, `POST /api/jobs/{id}/run`; feature `jobs`. Store:
  `<home>/remote/jobs/jobs.json` (0600).
- Code: `crates/nightloom-service/src/jobs/`, `remote/job_routes.rs`,
  `apps/desktop/src-tauri/src/jobs.rs`, `remoteHandlers.ts` (`runJob`),
  `src/remote/jobs.ts`, `JobsSheet.svelte`.

### Research watch (item 794, 2026-11-18)

A watch is a job that keeps one note current on a topic. Make one from the
drawer → **Jobs** → New watch, or type "keep this current: <topic>" (also
"keep current —", "keep me posted on …") in any chat: the form opens on a
proposal — the instructions, the pages named in his words, every morning —
all editable before **Start watch**; nothing is sent.

- **Each run** sends his instructions plus a block made in code: the
  topic, the sources (OpenAlex's and arXiv's open search pages, opened with
  `WebFetch`, so the read-only hold needs no connector; the pages he named;
  a web search), the note's latest ~6,000 characters, and the answer's
  shape (line 1 "Nothing new." or what changed; then "- claim — URL").
- **The note** is written by the host, never the model:
  `<project workspace>/.agents/watch-<slug>.md` (unfiled jobs:
  `<home>/watch/`), opened append-only, so earlier entries are never
  rewritten. A claim whose URL the run opened with `WebFetch` is tagged
  `external`; any other is kept, tagged `unverified`, and is not a change.
  Nothing new is one line: `- 2026-11-18 8:00 AM — Nothing new.`
- **Pushes only on change**: the run's turn-end "Finished" push is held
  (`watch::is_quiet` in `Push::notify`); a run with at least one verified
  new claim pushes its first line (`What::Watch`). A failed run still says
  "Failed".
- The Jobs row says which note it keeps; the last-run line is the
  headline with counts, and the cost per run is the job's usual line.
  Pause, Run now and Delete (asks; the note stays) are the job's.
- Code: `crates/nightloom-service/src/jobs/watch.rs`, `Job::watch`,
  `src/remote/jobs.ts` (`parseWatch`, `proposeWatch`), `JobsSheet.svelte`.

## The runaway guard (item 784, 2026-11-17)

A run nobody is watching pauses when it looks stuck, and asks him.

- **Stuck** is the same tool call (same tool, same input, exactly) returning
  the same result (same text, same error flag) three times in a row, counted
  per thread (the main chat and each subagent apart). Anything in between —
  another call, a changed output — starts the count again, so a poll whose
  output changes is never stopped. A job's run also pauses past a calls
  ceiling: 200 on its first two runs, then three times its largest recent
  run (at least 60); the count of each finished run is kept on the job
  (`recent_calls`, read from its chat's log).
- **Nobody watching**: a job's run always; on the Mac, no input for two
  minutes (the push's "at the Mac" rule); on the away server, no phone on
  its event stream. Asked at the moment it trips (`TurnEnv::unattended`).
- **The pause** (`agent_turn.rs`, both hosts): the CLI is interrupted as
  Stop interrupts it (item 074: the CLI closes the turn in its session), so
  nothing more is spent; a card named `nightloom_stuck` goes out on the
  approval channel — the Mac's `StuckCard.svelte`, the phone's card, and a
  push whose body says what ran ("Looks stuck: ran `cargo test` 3 times,
  same result"). **Continue** resumes the same CLI session with a note, and
  the guard then needs twice the repeats (and twice the calls) before it
  pauses again. **Stop** ends the run; everything it did stays on the log,
  with one line saying why, and the Jobs list shows the run as "stopped,
  looked stuck".
- Not covered: nightshift nights (`claude -p --output-format json`, no
  event stream; the equivalent is a `PostToolUse` hook, a patch note in
  nightshift's `wave-m-784-report-2026-11-17.md`).
- Code: `crates/nightloom-service/src/runaway.rs` (the guard, pure),
  `agent_turn.rs` (the pause), `push` (`What::Stuck`, `Note::detail`),
  `jobs` (`recent_calls`, `Outcome::Stopped`), `src/lib/stuck.ts`,
  `StuckCard.svelte`, the phone's `cardKind`.

## Siri and the Action Button (item 744, 2026-11-16)

Two routes are shaped for Apple's Shortcuts app, so a Shortcut — run by
"Hey Siri", the Action Button, a Lock Screen control or the Shortcuts
widget — can talk to Nightloom without opening the page. Both are under
`/api`, behind the same bearer token, and answer **plain text**: one
sentence a Shortcut can speak or show.

- `POST /api/shortcut/send` — JSON `{ "text": "…", "chat": "…" }`, `chat`
  optional. With no `chat`, the message goes to **the last chat**: the one
  open on the Mac, else the one written in most recently. With a name, the
  most recent chat whose name matches, ignoring case — an exact match
  first, then one that starts with it, then one that contains it. Answers
  `202` with "Sent to Scorer review." or "Queued in Scorer review; it goes
  when the running turn ends."; `404` "No chat is called “budget”."; `409`
  with the Mac's sentence when it refused (no engine, busy elsewhere);
  `400` for an empty message. The message is the Mac window's own send,
  exactly as a typed one.
- `GET /api/shortcut/running` — "Nothing is running.", or "2 chats are
  running: Scorer review, 4 minutes in, waiting on 1 approval; Signup
  flow, under a minute in."

**The two Shortcuts, built by hand** (Shortcuts cannot be shipped as a
file signed for someone else's iPhone, so this is the recipe). The
address is the one in the QR's link in Settings → Remote — with HTTPS
on, `https://<machine>.<tailnet>.ts.net:8642` (**the name, not the 100.x
address**: the certificate is for the name, so `https://100.x.y.z` fails
its check and `http://` gets no answer from an HTTPS listener — both
measured 2026-11-16 on the installed build: `http` no reply, `https` to
the address 401 with no token). Below, `<base>` is that address. The
token is from **Show the token** there.
Paste it into the header field only — never into a note or a message.

*Send to Nightloom*
1. Shortcuts → **+** → name it "Tell Nightloom" (the name is what Siri
   hears).
2. Add **Dictate Text** (Stop Listening: After Pause).
3. Optional, for a named chat: add **Ask for Input** (Text, prompt "Which
   chat? Leave empty for the last one"), or put a fixed name in the body
   below instead.
4. Add **Get Contents of URL**: URL `<base>/api/shortcut/send`;
   Method **POST**; Headers: `Authorization` = `Bearer <token>`; Request
   Body **JSON**: `text` = *Dictated Text*, and `chat` = *Provided Input*
   (or a fixed name, or leave the `chat` field out).
5. Add **Speak Text** with *Contents of URL* (or **Show Result**).

*What's running*
1. New Shortcut "What's running in Nightloom".
2. **Get Contents of URL**: `<base>/api/shortcut/running`,
   Method **GET**, the same `Authorization` header.
3. **Speak Text** with *Contents of URL*.

**Action Button and Lock Screen:** Settings → Action Button → Shortcut →
pick "Tell Nightloom"; a Lock Screen control: long-press the Lock Screen →
Customize → Lock Screen → a control slot → Shortcut. Siri runs either by
its name. Whether iOS asks for Face ID first on the Lock Screen depends on
the actions (not checked here: these three — dictate, fetch a URL, speak —
touch no personal data, which is what usually triggers the ask). The
phone must be on the tailnet (Tailscale's VPN on, or **VPN On Demand** in
the Tailscale app so it connects by itself), or the call fails with "could
not connect". *Unmeasured in this build:* the Lock Screen run on his
iPhone — the routes are tested on loopback only.

## Home, the phone's first screen (item 763 H8 / item 741, 2026-11-17)

The page opens on **Home** when its address names no place — the Home
Screen icon, a pairing link — and a reload keeps whatever screen it was on.
The drawer's **Home** button and Back from a chat opened there return to it.
In order (design §7's, the default until his layout pick, blocker 2084):

1. **Header** — "Home · 3 need you · today 0.3% of the week": the count of
   the rows below and, from `GET /api/home/today`, the share of the week
   Home's own unattended runs used today (left off when the host has no such
   route). When those runs are stopped, one line under it says why.
2. **Needs you** — each chat whose last news waits on him (`/api/push/feed`:
   an approval, a question, a stuck run), each job whose read-only run wanted
   changes (`/api/jobs`, the Jobs list's own approval card), each held
   blocker (`GET /api/home/held`, answered with the Nightshift sheet's own
   box). An open-chat approval has **Allow / Deny**; a question asked at a
   turn's end has a **reply box** (its text is that chat's own composer
   draft); the rest **Open** their chat, where the card is.
3. **Today's scan** — `GET /api/home/scan`: `scans/<today>.md`, else the
   newest page ("from 2026-11-16"); "ran 8:00 AM"; a skipped scan says why
   (the page's `Skipped: …` line) above its code-only page. Open on the
   first look at a day's page, folded on the next.
4. **Done since you looked** — `GET /api/home/feed` (Home's `feed.jsonl`,
   newest first) after `seen.json`'s time; each row opens its chat; **Mark
   all seen** is `POST /api/home/seen`.
5. **Running** — `/api/running`, with each chat's context size
   (`Running.contexts`, tokens by chat id).
6. **Tell Home…** — sends into today's Home chat (the scan job's chat, else
   Home's newest), or starts Home's first chat. The draft is kept on every
   keystroke under that chat's own composer key; a host that does not answer
   holds it in the page's queue, as the composer does. Then the **Jobs** row
   (count, the next run) opens the Jobs sheet.
7. **Home on this Mac** — Messages, Contacts, Reminders, Calendar (item
   808's panel), when present.

Its scroll and folds are kept (`nightloom.remote.home` in the page's
storage). Both hosts serve the same routes from their own config folder: the
away server's copy is the synced one, and the page says "The Mac is not
answering · as of 11:40 PM" (the feed file's time) when only it answers.

**"What needs me?" for Siri** — `GET /api/shortcut/needs`, plain text like
the other two: "Nothing needs you.", or "Three things need you: an approval
in Scorer review, a question from Home, one held blocker." (four named at
most, then "and 2 more"). The Shortcut, by hand as above:
1. New Shortcut "What needs me" (the name Siri hears).
2. **Get Contents of URL**: `<base>/api/shortcut/needs`, Method **GET**,
   Headers `Authorization` = `Bearer <token>`.
3. **Speak Text** with *Contents of URL*.

"Tell Home …" needs no new route: the *Send to Nightloom* Shortcut above
with `chat` fixed to `Home` (the name match takes the newest chat whose name
starts with "Home"). *Unmeasured in this build:* both on his iPhone — the
routes are tested on loopback only.

## Saved prompts in the phone's boxes (item 800, 2026-11-18)

- **What.** Typing `/word` in the chat's box, an aside's or a job's prompt
  shows the saved prompts whose names start with it, in a strip above the
  box (`remote/promptBox.ts`, a `use:promptBox` action). A tap puts the
  prompt in place of the `/word` with `{clipboard}` (Safari's own paste
  read), `{date}` and `{selection}` filled and the first blank selected;
  while blanks are left the strip shows ‹ and **Next blank ›** (a hardware
  keyboard's Tab / ⇧Tab do the same).
- **Route.** `GET /api/saved-prompts` → `{ "prompts": [{ "name", "body" }] }`,
  the live prompts in Settings' order, read from `<config>/saved-prompts.json`
  (`saved_prompts.rs`). Read only: the Mac's Settings → Saved prompts edits
  them. The page reads it on connect and when it comes back to the front.
  The away server answers from its own config directory, so it offers only
  what was saved on that machine (not synced).

## Approval rules and "Not now — carry on" (item 743, 2026-11-16)

- **Rules.** The chat's ⋯ sheet → More → *Approval rules* (and *Rules* on an
  approval card) lists what is in force for the chat and for every chat on
  the host, in the order it decides — **block, then ask, then allow** — with
  the built-in defaults under it. A rule names a tool (`Bash`, `Write`,
  `mcp__github__*`) and, optionally, text the call must name (Bash's command,
  a file tool's path, WebFetch's address). Tap a rule to change it; Remove
  asks first and says what those calls do next. "Allow for this chat" from a
  card lists here as an allow rule and can be removed.
- **An allow on Bash is narrow on purpose:** the command must *start* with
  the text and be one plain command — anything chained (`&&`, `;`, a pipe, a
  redirect, `$(…)`) still asks. Ask and block rules match the text anywhere.
- **Where they apply:** chats on Ask or Plan, on the Claude Code engine — the
  hook that reads them is registered only there. On Auto, Claude Code's
  classifier decides and no rule is consulted. Rules cannot name the model's
  questions, plans, Playwright (its own switch) or `add_folder` (always a
  card), nor a tool the hook is never asked about (`Read`, `Grep`).
- **Files:** `<home>/approval-rules.json` (every chat) and
  `<the chat's ask folder>/approval-rules.json`; the hook
  (`--permission-hook`) reads both on every call, so a change applies to the
  next call of a running turn.
- **Not now — carry on** on a call's card (hosts naming the `later` feature):
  the call is refused once with words telling the model it is set aside —
  do the rest, then make the same call again as the last step — so the card
  returns at the end. If the reply ends without that call coming back, the
  turn says so in a notice; it did not run. Measured before it was built
  (nightshift `notes/runner-design/743-measure/`).
- Routes, behind the bearer: `GET /api/rules?chat=&project=`,
  `POST /api/rules?chat=&project=` (`{op: add|change|remove, …}`);
  `POST /api/approve` takes `decision: "later"`.
- Code: `crates/nightloom-service/src/approval_rules.rs` (store, matcher,
  listing), `agent/ask.rs` (`decide_under`, `Answer::Later`),
  `remote/rules_routes.rs`, `src/remote/rules.ts`, `RulesSheet.svelte`.

## What is not here (yet)

Source: `mod.rs:24–30`. Tailscale identity headers (they need `tailscale
serve` in front of the port; later) — the only claim left of the old list. The
attachments (images, documents), the folder and project pickers and New
project, the settings rail (`/api/rail`), Nightshift's blockers and mornings,
and notes are all built (see "What the phone page does"). Shape A and Shape C
are separate items.

## Where the code lives

- `crates/nightloom-service/src/remote/` — 16 files: `mod.rs` (the axum server
  over a `Host` trait, the routes, the bearer check, the SSE relay), `api.rs`
  (the one API's types, `api::feature`), `tailnet.rs` (the tailnet address),
  `token.rs` (the token), `voice_ws.rs` (`/api/voice`), `resent.rs`,
  `sync_routes.rs`, `rules_routes.rs`, `saved_prompt_routes.rs`,
  `job_routes.rs`, `push_routes.rs`, `nightshift_routes.rs`,
  `feedback_routes.rs`, `home_routes.rs`, `home_phone_routes.rs`,
  `shortcut_routes.rs`. Beside it: `src/tls.rs` (the certificate),
  `src/credentials.rs` (the token's source). Tests bind loopback under
  `cfg(test)` only.
- `apps/desktop/src-tauri/src/remote.rs` — `DesktopHost`, the relay, the
  managed `Remote` state, and the commands `remote_status`, `remote_sent`,
  `push_note`, `remote_claim`, `remote_done`, `remote_start`, `remote_stop`,
  `remote_set_keep_awake`, `remote_token`, `remote_self_test` (ten;
  `remote.rs:2056–2469`).
- `apps/desktop/remote.html` and `apps/desktop/src/remote/` — a second Vite
  entry of the same build: `main.ts`, `Remote.svelte`, `client.ts`, and about
  thirty components and modules: the sheets (`AsideSheet`, `ChangesSheet`,
  `ContextSheet`, `CouncilSheet`, `FeedbackSheet`, `JobsSheet`,
  `NightshiftSheet`, `NotesSheet`, `ProjectsSheet`, `RailSheet`, `RulesSheet`,
  `RunningSheet`), `ChatMenu`, `MessageMenu`, `LayerEditor`, `HomeFirst`,
  `HomeStage`, `Hosts`, `SecretAsk`, `PushRow`, `UsageLine`, `ProjectPage`,
  `JobChatCard`, `JobApproval`, `JobRunConfirm`, `BlockerAnswer`, and
  `voice/` (`MicButton`, `Orb`, `SpeechTest`, `Voice`, capture, player, vad).
  `apps/desktop/public/remote/` holds the manifest, the icons and
  `push-sw.js`.
- `apps/desktop/src/lib/remoteHandlers.ts:988–1008` — the three `remote-*`
  listeners (`remote-send`, `remote-approve`, `remote-cancel`);
  `SettingsModal.svelte` — the Remote card.

## Approval follow-ups (nightshift item 783)

- **One rule set for both hosts.** The every-chat rules (`approval-rules.json` in the config directory) are the same
  on the Mac and the away server: the Mac's sync pass (`away.rs`) merges the two three-way against the last synced
  set (`approval-rules.synced.json`, Mac only) over `GET`/`PUT /api/sync/rules`
  (`approval_rules/shared.rs`). A rule both hosts changed is kept twice and the sheet says so (`notes`, dismissed
  with `{op: "dismiss"}`). Every-chat rule ids are `a-<uuid>`; older `a<n>` ids are replaced on first list or sync.
- **Read-only chats ask instead of refusing.** Where the Ask hook is registered, a connector action that is not a
  known read, and Nightloom's `remember`, go to the hook with `--read-only` (`ask::decide_read_only`,
  `connector_writes::CARD_MATCHER`) and defer: `tool-approval` carries `kind: "connector" | "remember"`. On a
  `connector` card `decision: "always"` adds the tool to the every-chat file's `reads` (listed as `source: "read"`,
  removable as `read:<tool>`); on `remember` it is a plain allow. A **known write** — a verb on
  `connector_writes::WRITE_VERBS` (send, reply, forward, trash, delete, create, update, label, upload, share, move…)
  — is still refused there (`KNOWN_WRITES_MATCHER`, with Nightloom's own note writes); only a verb on neither list
  gets the card.
- **Unattended runs never wait on a read-only card.** When nobody is there (`TurnEnv::unattended`: on the away server
  no subscriber to the event stream; on the Mac no input for 2 minutes and no phone connected), such a card is never
  shown: `approval-nudge {stage: "unattended"}` and a push go out, the call is refused with
  `ask::UNATTENDED_REASON` (never run, not to be made again this run), and the reply's end lists it — so a job
  finishes and frees the away server's one turn.
- **Unanswered approvals** (`ask::APPROVAL_TIMES`): the card's push at 0:00, `approval-nudge {stage: "remind"}` and
  a second push at 2:30, `{stage: "set_aside"}` at 3:30 — the call is refused with `ask::AUTO_LATER_REASON` (never
  run), its card withdrawn, a short push sent; the same call comes back at the reply's end with `back: true` and then
  waits without a timer. Questions, plans and folder cards are never timed. A set-aside writes only that call's
  refusal (`AskDir::write_set_aside`) — never Playwright's answer for the reply, so the call that comes back gets its
  card.
