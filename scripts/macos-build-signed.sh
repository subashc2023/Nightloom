#!/bin/bash
# `cargo tauri build` on macOS with the bundle signed by the same identity
# scripts/macos-sign-and-run.sh uses for dev builds, so the installed
# Nightloom.app and the dev binary share one keychain identity — one
# "Always Allow" per stored key covers both, across reinstalls.
#
#   scripts/macos-build-signed.sh [cargo tauri build args…]
#
# Tauri's bundler reads APPLE_SIGNING_IDENTITY; the bundle identifier
# (app.nightloom.desktop, from tauri.conf.json) becomes the code identifier,
# which is what the dev runner signs with too. NIGHTLOOM_SIGN_IDENTITY
# overrides the identity; with none found the build proceeds ad hoc and says so.
set -u
identity="${NIGHTLOOM_SIGN_IDENTITY:-}"
if [[ -z "$identity" ]]; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Apple Development: [^"]*\)"$/\1/p' | head -1)"
fi
if [[ -z "$identity" || "$identity" == "-" ]]; then
  echo "macos-build-signed: no Apple Development identity found; building ad hoc" >&2
  exec cargo tauri build "$@"
fi
echo "macos-build-signed: signing the bundle as $identity" >&2
APPLE_SIGNING_IDENTITY="$identity" exec cargo tauri build "$@"
