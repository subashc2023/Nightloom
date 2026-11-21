#!/usr/bin/env bash
# Turn the failing part of each CI log into error annotations (item 864).
# A run's job logs need a signed-in admin to download; its annotations are
# public through the check-runs API
# (`/repos/<owner>/<repo>/check-runs/<job id>/annotations`), so this is what
# makes a red run readable from outside.
#
# GitHub cuts each annotation at 4096 characters and keeps at most 10 errors
# and 10 warnings per step, so one log becomes: an error naming every failed
# test, then one annotation per failed test's output block
# (`---- name stdout ----` through its panic message), errors first, then
# warnings. A log with no failed test (a compile error) gets its error lines.
#
# Usage: ci-failure-annotations.sh <log>...  (missing logs are skipped)
set -u
MAX=3900

# Workflow-command escaping: % first, then CR and LF.
esc() {
  local s=${1:0:$MAX}
  s=${s//'%'/'%25'}
  s=${s//$'\r'/'%0D'}
  s=${s//$'\n'/'%0A'}
  printf '%s' "$s"
}

errors=0
warnings=0
emit() { # $1 title, $2 body
  local title=${1//[,:]/ }
  if [ "$errors" -lt 10 ]; then
    echo "::error title=${title}::$(esc "$2")"
    errors=$((errors + 1))
  elif [ "$warnings" -lt 10 ]; then
    echo "::warning title=${title}::$(esc "$2")"
    warnings=$((warnings + 1))
  fi
}

for log in "$@"; do
  [ -f "$log" ] || continue
  name=$(basename "$log")
  # CARGO_TERM_COLOR=always: strip the colour codes before matching.
  plain=$(sed -E 's/\x1b\[[0-9;]*[mK]//g' "$log" | tr -d '\r')

  failed=$(printf '%s\n' "$plain" | grep -E '^test .* \.\.\. FAILED$' \
    | sed -E 's/^test (.*) \.\.\. FAILED$/\1/' | sort -u)
  if [ -n "$failed" ]; then
    emit "$name $(printf '%s\n' "$failed" | wc -l | tr -d ' ') failed" "$failed"
    # One block per failed test: from its `---- ... stdout ----` line to the
    # next one, or to the `failures:` list that follows the last.
    while IFS= read -r -d $'\x1e' block; do
      block=${block#$'\n'}
      [ -n "$block" ] || continue
      t=$(printf '%s\n' "$block" | head -n 1 | sed -E 's/^---- (.*) stdout ----$/\1/')
      emit "$t" "$block"
    done < <(printf '%s\n' "$plain" | awk '
      /^---- .* stdout ----$/ { if (b != "") printf "%s\036", b; b = $0; next }
      /^failures:$/ { if (b != "") printf "%s\036", b; b = ""; next }
      b != "" { b = b "\n" $0 }
      END { if (b != "") printf "%s\036", b }')
    continue
  fi

  body=$(printf '%s\n' "$plain" \
    | grep -E -A4 '^(error|warning)(\[[A-Z0-9]+\])?: |panicked at ' \
    | head -n 150)
  [ -n "$body" ] || body=$(printf '%s\n' "$plain" | tail -n 60)
  emit "$name" "$body"
done
exit 0
