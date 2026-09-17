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
with a sentence naming it.

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
Remote encodes `http://<address>:<port>/#token=<token>`. The token rides
the fragment, which never leaves the browser — not in a request, not in a
referer — and the page moves it into local storage and strips it from the
address bar the moment it loads. The event stream is read with `fetch`
rather than `EventSource` for the same reason: `EventSource` cannot send a
header, and the token must not go in a URL.

**Regenerate** (in the card) replaces the token and restarts a running
listener with it; every phone must scan again.

## Setting it up on the phone

1. On the Mac: Tailscale open and signed in. Settings (⌘,) → **Remote** →
   switch **On**. The card shows the bound address and port (read-only),
   a QR code, and the token as text (Show).
2. On the iPhone: Tailscale open and connected. Camera → point at the QR →
   tap the link → Safari opens `http://100.x.y.z:8642/`. The chat list of
   the open project appears, the open chat marked. The address bar no
   longer shows `#token`.
3. Share → **Add to Home Screen** → open it from there: full screen, no
   Safari chrome, the Nightloom icon. (Without the QR: open the address in
   Safari and paste the token into the field on the first screen.)
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

## What is not here (yet)

Attachments, folder pickers, settings, Nightshift's blockers and morning
page, notes; push notifications; Tailscale identity headers (`tailscale
serve` in front of the port; later). Shape A and Shape C are separate
items.

## Where the code lives

- `crates/nightloom-service/src/remote/` — the axum server over a `Host`
  trait (`mod.rs`), the tailnet address (`tailnet.rs`), the token and QR
  (`token.rs`). Tests bind loopback under `cfg(test)` only.
- `apps/desktop/src-tauri/src/remote.rs` — `DesktopHost`, the relay, the
  managed `Remote` state, the five commands (`remote_status`, `remote_start`,
  `remote_stop`, `remote_set_keep_awake`, `remote_token`).
- `apps/desktop/remote.html`, `src/remote/` (`main.ts`, `Remote.svelte`,
  `client.ts` + its tests), `public/remote/` (the manifest and icons) —
  a second Vite entry of the same build.
- `src/lib/state.svelte.ts` (`init`) — the three `remote-*` listeners;
  `SettingsModal.svelte` — the Remote card.
