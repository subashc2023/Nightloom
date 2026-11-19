#!/usr/bin/env bash
# Turn the failing part of each CI log into one error annotation (item 864).
# A run's job logs need a signed-in admin to download; its annotations are
# public through the check-runs API
# (`/repos/<owner>/<repo>/check-runs/<job id>/annotations`), so this is what
# makes a red run readable from outside: compiler errors with their
# locations, and each failed test's name and panic message.
#
# Usage: ci-failure-annotations.sh <log>...  (missing logs are skipped)
set -u
for log in "$@"; do
  [ -f "$log" ] || continue
  # CARGO_TERM_COLOR=always: strip the colour codes before matching.
  plain=$(sed -E 's/\x1b\[[0-9;]*[mK]//g' "$log" | tr -d '\r')
  body=$(printf '%s\n' "$plain" \
    | grep -E -A4 '^(error|warning)(\[[A-Z0-9]+\])?: |^---- .* stdout ----$|^test .* \.\.\. FAILED$|panicked at ' \
    | head -n 150)
  [ -n "$body" ] || body=$(printf '%s\n' "$plain" | tail -n 60)
  # Workflow-command escaping: % first, then newlines.
  body=${body//'%'/'%25'}
  body=${body//$'\n'/'%0A'}
  echo "::error title=$(basename "$log")::${body}"
done
exit 0
