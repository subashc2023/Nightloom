#!/bin/bash
# Cargo runner for macOS: sign the binary with a STABLE identity, then run it.
#
# Why (2026-09-11): `cargo tauri dev` runs `cargo run`, and a plain dev build
# is ad-hoc, linker-signed — its code identity is a per-build hash. macOS
# keychain stores "Always Allow" against the app's code identity, so every
# rebuild was a new app and every stored API key asked for the login password
# again (five to fifteen dialogs per rebuild). Signed with a real developer
# certificate and a fixed identifier, the designated requirement is
#   identifier "app.nightloom.desktop" and anchor apple generic and
#   certificate leaf[subject.CN] = "<the identity>" …
# which is the same for every build, so one "Always Allow" per key holds for
# good — and the installed Nightloom.app, signed the same way (see
# scripts/macos-build-signed.sh), shares that grant.
#
# Wired in .cargo/config.toml under [target.aarch64-apple-darwin] and
# [target.x86_64-apple-darwin], so cargo invokes this as
#   scripts/macos-sign-and-run.sh <binary> [args…]
# for `cargo run` and for test binaries. Only binaries named nightloom-desktop*
# are signed (NIGHTLOOM_SIGN_ALL=1 signs whatever it is handed); everything
# else, and any machine without an identity, is run untouched. Never fails the
# run: a signing problem is printed and the binary runs as it would have.
#
# Identity: NIGHTLOOM_SIGN_IDENTITY if set, else the first "Apple Development"
# identity `security find-identity` lists. NIGHTLOOM_SIGN_IDENTITY=- disables.
set -u
bin="${1:-}"; shift || true
[[ -n "$bin" ]] || { echo "macos-sign-and-run: no binary given" >&2; exit 2; }

identifier="${NIGHTLOOM_SIGN_IDENTIFIER:-app.nightloom.desktop}"
name="$(basename "$bin")"
want=0
case "$name" in nightloom-desktop*) want=1 ;; esac
[[ "${NIGHTLOOM_SIGN_ALL:-0}" == "1" ]] && want=1

if [[ $want -eq 1 && "$(uname -s)" == "Darwin" ]]; then
  identity="${NIGHTLOOM_SIGN_IDENTITY:-}"
  if [[ -z "$identity" ]]; then
    identity="$(security find-identity -v -p codesigning 2>/dev/null \
      | sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Apple Development: [^"]*\)"$/\1/p' | head -1)"
  fi
  if [[ "$identity" == "-" || -z "$identity" ]]; then
    echo "macos-sign-and-run: no signing identity; running $name ad hoc (keychain will ask again after each rebuild)" >&2
  else
    # Skip when the binary already carries this identity and identifier: a
    # `cargo run` on an unchanged binary must not re-sign for nothing.
    current="$(codesign -dv --verbose=2 "$bin" 2>&1)"
    if grep -q "^Identifier=$identifier\$" <<<"$current" && grep -q "^Authority=$identity\$" <<<"$current"; then
      :
    elif codesign --force --sign "$identity" --identifier "$identifier" "$bin" 2>/tmp/macos-sign-and-run.err; then
      echo "macos-sign-and-run: signed $name as $identifier ($identity)" >&2
    else
      echo "macos-sign-and-run: codesign failed, running unsigned: $(tr '\n' ' ' </tmp/macos-sign-and-run.err)" >&2
    fi
  fi
fi
exec "$bin" "$@"
