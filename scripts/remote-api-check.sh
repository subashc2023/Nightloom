#!/usr/bin/env bash
# The phone API's check, run against any host by URL and token (item 246;
# design notes/research/246-phone-parity-voice-design-2026-09-30.md §4–§5,
# in the nightshift-code repo). Waves 1–4 reuse it: the Mac's listener, a
# local `nightloom-cli serve`, and the Fly machine all answer the same routes.
#
#   scripts/remote-api-check.sh http://100.x.y.z:8642 <token>          # reads only
#   scripts/remote-api-check.sh http://100.x.y.z:8642 <token> --write  # + safe writes
#
# Reads change nothing. `--write` adds only writes that cost no model turn
# and leave the host as they found it: a note written, read back and
# deleted (to the trash), and the rail's model sent back unchanged. It
# never sends a message, starts a chat, or acts on a chat's log — those
# are for the live pass, against a dev build, by hand.
#
# Every line is PASS, FAIL or LACKS. LACKS is a 501 "not available on this
# host": a feature this host has not adopted, reported, not failed — but a
# LACKS for a feature the host lists in `/api/state`'s `features` is a
# FAIL. The exit code is the number of FAILs (0 = all good).
#
# Needs curl and jq. The token is sent only in the Authorization header,
# never in a URL.

set -u

if [ $# -lt 2 ]; then
  echo "usage: $0 <base-url> <token> [--write]" >&2
  exit 64
fi
BASE="${1%/}"
TOKEN="$2"
WRITE="${3:-}"
for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "needs $tool" >&2; exit 64; }
done

FAILS=0
PASSES=0
LACKS=0
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

pass() { PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL  %s — %s\n' "$1" "$2"; }
lacks() {
  # A 501 for a listed feature is a lie in `features`: FAIL.
  if printf '%s\n' "$FEATURES" | grep -qx "$2"; then
    fail "$1" "501 but the host lists '$2' in features"
  else
    LACKS=$((LACKS + 1)); printf 'LACKS %s (feature %s)\n' "$1" "$2"
  fi
}

# call METHOD PATH [JSON] [auth|noauth] -> sets STATUS, body in $BODY
call() {
  local method="$1" path="$2" data="${3:-}" auth="${4:-auth}"
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method" --max-time 20)
  [ "$auth" = auth ] && args+=(-H "Authorization: Bearer $TOKEN")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data "$data")
  STATUS="$(curl "${args[@]}" "$BASE$path" 2>/dev/null)" || STATUS="000"
}

# expect NAME FEATURE JQ-FILTER : 200 and the filter true; 501 is LACKS.
expect() {
  local name="$1" feature="$2" filter="$3"
  case "$STATUS" in
    200)
      if jq -e "$filter" "$BODY" >/dev/null 2>&1; then pass "$name"
      else fail "$name" "200 but the body is not the shape ($filter): $(head -c 200 "$BODY")"; fi ;;
    501) lacks "$name" "$feature" ;;
    *) fail "$name" "HTTP $STATUS: $(head -c 200 "$BODY")" ;;
  esac
}

echo "== $BASE"

# --- the page and the bearer ---
call GET / "" noauth
[ "$STATUS" = 200 ] && pass "GET / (the page, no token)" || fail "GET /" "HTTP $STATUS"

call GET /api/state "" noauth
[ "$STATUS" = 401 ] && pass "GET /api/state without a token is 401" || fail "no-token state" "HTTP $STATUS"

call GET /api/state
FEATURES=""
if [ "$STATUS" = 200 ] && jq -e 'has("busy") and has("connected")' "$BODY" >/dev/null 2>&1; then
  pass "GET /api/state"
  FEATURES="$(jq -r '.features // [] | .[]' "$BODY")"
  ACTIVE="$(jq -r '.active_chat // empty' "$BODY")"
  echo "      features: $(printf '%s ' $FEATURES)"
  echo "      open chat: ${ACTIVE:-none}"
else
  fail "GET /api/state" "HTTP $STATUS: $(head -c 200 "$BODY")"
  echo "cannot go on without the state"; exit 1
fi

# Every route refuses a missing token before anything else.
for route in "GET /api/chats" "GET /api/projects" "GET /api/events" "POST /api/send" \
  "POST /api/chats/x/act" "GET /api/chats/x/context" "POST /api/chats/x/context" \
  "POST /api/chats/x/layers" "GET /api/rail" "POST /api/rail" "GET /api/running" \
  "GET /api/usage" "GET /api/search?q=x" "POST /api/projects" "POST /api/projects/x/open" \
  "POST /api/projects/x/rename" "POST /api/projects/x/forget" "GET /api/notes" \
  "GET /api/notes/project/x.md" "PUT /api/notes/project/x.md" "DELETE /api/notes/project/x.md" \
  "GET /api/nightshift" "GET /api/nightshift/x/queue" "POST /api/nightshift/x/blockers/x/answer" \
  "POST /api/dream" "POST /api/capture" \
  "GET /api/not-a-route"; do
  call ${route% *} "${route#* }" "" noauth
  if [ "$STATUS" = 401 ]; then OPEN_OK=$((${OPEN_OK:-0} + 1))
  else fail "$route without a token" "HTTP $STATUS, not 401"; fi
done
[ "${OPEN_OK:-0}" = 27 ] && pass "every route says 401 without a token (27 checked)"

call GET /api/not-a-route
[ "$STATUS" = 404 ] && pass "an unknown route with the token is 404" || fail "unknown route" "HTTP $STATUS"

# --- reads from before wave 1 (every host has them) ---
call GET /api/chats;    expect "GET /api/chats" base 'type == "array"'
call GET /api/projects; expect "GET /api/projects" base 'type == "array" and (length == 0 or (.[0] | has("id") and has("name") and has("active")))'
if [ -n "${ACTIVE:-}" ]; then
  call GET "/api/chats/$ACTIVE/transcript"; expect "GET the open chat's transcript" base 'type == "array"'
fi

# --- wave 1 reads ---
call GET /api/rail;    expect "GET /api/rail" rail 'has("engine") and has("model") and has("effort") and has("connected")'
call GET /api/running; expect "GET /api/running" running '.chats | type == "array"'
call GET /api/usage;   expect "GET /api/usage" usage '.plan | has("source")'
call GET '/api/search?q=the&scope=all'; expect "GET /api/search" search 'has("matches") and has("groups")'
call GET '/api/search'
[ "$STATUS" = 400 ] || [ "$STATUS" = 501 ] && pass "a search with no query is refused" || fail "empty search" "HTTP $STATUS"
call GET '/api/notes?scope=project'; expect "GET /api/notes" notes 'type == "array"'
if [ -n "${ACTIVE:-}" ]; then
  call GET "/api/chats/$ACTIVE/context"; expect "GET the open chat's context" context '.view | has("messages") and has("totals")'
fi

# --- wave 5: Nightshift, read only (blocker 669: the phone reads and answers;
# this script never answers a blocker or adds an item) ---
call GET /api/nightshift
expect "GET /api/nightshift" nightshift 'type == "array" and (length == 0 or (.[0] | has("id") and has("name") and has("open_blockers")))'
if [ "$STATUS" = 200 ] && NS="$(jq -r '.[0].id // empty' "$BODY")" && [ -n "$NS" ]; then
  call GET "/api/nightshift/$NS/queue";    expect "GET a Nightshift queue" nightshift '.items | type == "array"'
  call GET "/api/nightshift/$NS/blockers"; expect "GET its open blockers" nightshift '.blockers | type == "array"'
  call GET "/api/nightshift/$NS/mornings"; expect "GET its morning pages" nightshift 'type == "array"'
fi

# --- wave 1: input the listener itself refuses (400/422, whatever the host) ---
call POST /api/chats/x/act '{"op":"kind","kind":"novel"}'
[ "$STATUS" = 400 ] && pass "an act no host could take is 400" || fail "bad act" "HTTP $STATUS"
call POST /api/chats/x/act '{"op":"explode"}'
[ "$STATUS" = 422 ] && pass "an unknown act op is 422" || fail "unknown op" "HTTP $STATUS"
call POST /api/rail '{}'
[ "$STATUS" = 400 ] && pass "an empty rail patch is 400" || fail "empty rail patch" "HTTP $STATUS"
call GET /api/notes/attic/x.md
[ "$STATUS" = 400 ] && pass "an unknown notes scope is 400" || fail "bad scope" "HTTP $STATUS"
call POST /api/send '{"text":"  "}'
[ "$STATUS" = 400 ] && pass "a blank send is 400 (nothing sent)" || fail "blank send" "HTTP $STATUS"

# --- --write: safe writes that leave the host as they found it ---
if [ "$WRITE" = "--write" ]; then
  NOTE="/api/notes/project/remote-api-check-$$.md"
  call PUT "$NOTE" '{"text":"# remote-api-check\n\nwritten by scripts/remote-api-check.sh; safe to delete"}'
  case "$STATUS" in
    204)
      pass "PUT a scratch note"
      call GET "$NOTE"; expect "GET it back" notes '.text | startswith("# remote-api-check")'
      call DELETE "$NOTE"
      [ "$STATUS" = 204 ] && pass "DELETE the scratch note (to the trash)" || fail "DELETE note" "HTTP $STATUS: $(head -c 200 "$BODY")" ;;
    501) lacks "PUT a scratch note" notes ;;
    *) fail "PUT a scratch note" "HTTP $STATUS: $(head -c 200 "$BODY")" ;;
  esac
  call GET /api/rail
  if [ "$STATUS" = 200 ]; then
    MODEL="$(jq -c '{model: .model}' "$BODY")"
    call POST /api/rail "$MODEL"
    expect "POST /api/rail with the model it already has" rail "has(\"model\") and .model == $(printf '%s' "$MODEL" | jq '.model')"
  fi
fi

echo "== $PASSES passed, $LACKS lacking (not on this host), $FAILS failed"
exit "$FAILS"
