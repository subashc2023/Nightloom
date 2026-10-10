# Nightloom's away server on Fly.io

The phone page and Claude Code turns while the Mac sleeps (nightshift item 268 step 2). One
machine, `nightloom-away-swaraag`, region `lax`, shared-cpu-2x / 2 GB (was 1x / 1 GB until voice; blocker
1187 holds that deploy), stopped when idle and
started by the next request; a 1 GB volume `nightloom_data` at `/data` holds the Nightloom home
(`/data/nightloom`), the CLI's HOME and session files (`/data/user`) and the work folder
(`/data/work`).

## Deploy (from the repo root)

    fly deploy . --config deploy/fly.toml --remote-only --ha=false

The build runs on Fly's builder (no Docker on the Mac). Secrets, never in files:
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and `NIGHTLOOM_REMOTE_TOKEN` (the phone's
bearer; the Mac keeps a copy in `~/.nightloom/remote/away-token`, mode 0600). The model is
`NIGHTLOOM_SERVE_MODEL` in `fly.toml`.

## Check

    scripts/remote-api-check.sh https://nightloom-away-swaraag.fly.dev "$(cat ~/.nightloom/remote/away-token)"

`serve` binds `0.0.0.0` only because the image sets `NIGHTLOOM_SERVE_PUBLIC=1`
(`Server::start_public`: plain HTTP behind Fly's TLS, a token of 32+ characters, every `/api`
route behind it).

Voice (item 246 part 4C): the image's `voice` stage runs `bin/voice-setup.sh` into
`/opt/nightloom/voice` (whisper.cpp's server built with `-DGGML_NATIVE=OFF`, `base.en` + `small.en`,
Piper in a venv, `en_US-lessac-medium`; ~0.9 GB); the entrypoint links `/data/nightloom/voice` to it
unless a real folder is there. `/api/state` then reports `voice`, and `/api/voice` works.
