# Remote — Nightloom on your phone over the tailnet

Nightshift backlog 091, Shape B (2026-09-16). A small HTTP server inside
the desktop process serves a phone-width page: the open project's chats, a
chat's transcript as it streams, Send, Stop, and the approval cards. The
turn still runs on the Mac; the phone is a window onto it. His wish list
(blocker 104, in his words): "see what it's doing, answer the permission
prompts, send it the next thing, from my phone, without a public server".

## What it exposes

Everything is under the listener's one address and port (default
`8642`, blocker 172):

- `GET /` — the page (`remote.html`), and its files under `/assets/` and
  `/remote/`. Nothing else in the bundle is reachable; the desktop's own
  `index.html` is a 404.
- Under `/api`, each with the bearer token:
  - `GET /state` — the project's name, the chat the desktop has open,
    `busy` (a turn holds the chat), `connected`, the engine, the pending
    approval prompts.
  - `GET /chats` — the sidebar's list for the open project.
  - `GET /chats/{id}/transcript` — the log's events, read from disk (so any
    chat is readable while another runs, and a transcript read mid-turn is
    the honest partial).
  - `POST /chats/{id}/send`, `POST /send` (the open chat) — `{ "text" }`;
    answers `202 Accepted`: the turn runs on the Mac, its progress comes
    down the stream.
  - `POST /approve` — `{ id, name, decision, reason?, answer?, then? }`,
    the desktop card's own payloads (`allow` · `always` · `deny`; a
    question form's answers; an approved plan with `ask`/`auto`).
  - `POST /cancel` — Stop.
  - `GET /events` — server-sent events: `hello` first, then the desktop's
    own `turn-event`, `tool-approval` and `turn-notice` window events by
    name with their payloads unchanged, a `lagged` event when the phone
    fell behind (it re-reads), a comment every 15 s to keep the connection.

A message or an answer from the phone is not run in Rust: it is handed to
the desktop window as a `remote-send` / `remote-approve` / `remote-cancel`
event, and the window's own `send`, `resolveApproval` and `cancelTurn` run
it. So the transcript, the composer's queue, the hand-off, the banner and
the sleep watch all see a phone message exactly as a typed one, and the
desktop's view is never a turn behind.

## The binding rule

**The listener binds the Mac's Tailscale address and nothing else** —
never `0.0.0.0`, never a LAN address, and there is no option for either
(blocker 105, its default taken). The address comes from `Tailscale ip -4`
(the app's bundled CLI, then `tailscale` on PATH), else from `ifconfig`'s
`100.64.0.0/10` line; the server refuses to start on any address outside
that range before a socket exists. With Tailscale off the switch fails
with a sentence naming it. While the listener is on, the card and the QR
show the address it is *bound* to, not whatever Tailscale answers now:
if the node's address changes (a re-login, a reset), switch Remote off
and on to bind the new one.

No TLS: the tailnet is WireGuard end to end, and a certificate the phone
would have to trust is a setup step this page exists to not have. Only
devices on *your* tailnet can reach the port at all; the token is what
stops another of them.

## The token

A bearer token, made once when the listener first goes on: one uuid v4's
random bits as 32 hex characters (blocker 173), stored in the keychain
beside the API keys (`remote:token`), never on disk. Every `/api` call
carries it as `Authorization: Bearer …`; a missing or wrong one is a 401
(the page then says "scan again"). The page and its files need none — the
page is not secret.

It reaches the phone through the page's own URL: the QR in Settings →
Remote encodes `https://<machine>.<tailnet>.ts.net:<port>/#token=<token>`
when HTTPS is set up (the certificate is for that name, not the address;
item 246), else `http://<address>:<port>/#token=<token>`. The token rides
the fragment, which never leaves the browser — not in a request, not in a
referer — and the page moves it into local storage and strips it from the
address bar the moment it loads. The event stream is read with `fetch`
rather than `EventSource` for the same reason: `EventSource` cannot send a
header, and the token must not go in a URL.

**Regenerate** (in the card) replaces the token and restarts a running
listener with it; every phone must scan again. Off, and a restart, end
every open event stream at once — a phone holding one is cut, not left
listening with the old token.

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
Settings sheet → **Notifications on this phone** is the Subscribe switch,
its off switch and "Send a test notification"; in Safari, or on the plain
HTTP link, the row says why it cannot be turned on.

- A push says the chat's name and its state — Finished, Failed, Paused by
  the usage limit, Waiting for your approval, Has a question for you — and
  nothing of the reply (blocker 2011). A tap opens that chat; the icon's
  badge is the number of chats waiting on him.
- None is sent while the Mac's keyboard or trackpad was touched in the last
  two minutes. The away server cannot know that and always sends.
- Routes, all behind the bearer: `GET /api/push`, `POST /api/push/subscribe`,
  `/unsubscribe`, `/seen`, `/test`, and `/key` (away server only). The
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

## What is not here (yet)

Attachments, folder pickers, settings, Nightshift's blockers and morning
page, notes (this list is stale; the phone-page audit item rewrites it); Tailscale identity headers (`tailscale
serve` in front of the port; later). Shape A and Shape C are separate
items.

## Where the code lives

- `crates/nightloom-service/src/remote/` — the axum server over a `Host`
  trait (`mod.rs`), the tailnet address (`tailnet.rs`), the token and QR
  (`token.rs`), the Shortcuts routes (`shortcut_routes.rs`, item 744).
  Tests bind loopback under `cfg(test)` only.
- `apps/desktop/src-tauri/src/remote.rs` — `DesktopHost`, the relay, the
  managed `Remote` state, the five commands (`remote_status`, `remote_start`,
  `remote_stop`, `remote_set_keep_awake`, `remote_token`).
- `apps/desktop/remote.html`, `src/remote/` (`main.ts`, `Remote.svelte`,
  `client.ts` + its tests), `public/remote/` (the manifest and icons) —
  a second Vite entry of the same build.
- `src/lib/state.svelte.ts` (`init`) — the three `remote-*` listeners;
  `SettingsModal.svelte` — the Remote card.
