# Nightloom's away server (nightshift item 268 step 2): `nightloom serve` with the phone page and
# the Claude Code CLI, on Fly.io. Adapted from Keepsake's deploy/Dockerfile.
# Build context is the repo root: `fly deploy --config deploy/fly.toml` from the root (deploy/README.md).

# ---- page: the phone page (apps/desktop/dist, which `serve --assets` serves) ----
FROM node:20-bookworm-slim AS page
WORKDIR /src/apps/desktop
COPY apps/desktop/package.json apps/desktop/package-lock.json ./
RUN npm ci
COPY apps/desktop ./
RUN npm run build

# ---- voice: the phone's voice mode (item 246 part 4C) — whisper.cpp's server, its two models,
# Piper in a venv and one voice, laid out by bin/voice-setup.sh exactly as on the Mac, under
# /opt/nightloom/voice. In the image, not on the /data volume (1 GB): ~0.9 GB that a rebuild
# replaces. The entrypoint links <NIGHTLOOM_HOME>/voice to it, where the service looks.
# GGML_NATIVE=OFF: the program must not use this build machine's CPU features (it would on
# by default), only the AVX2 baseline ggml then picks, which Fly's AMD EPYC hosts have (inferred).
FROM debian:bookworm-slim AS voice
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl build-essential cmake \
      python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
COPY bin/voice-setup.sh /usr/local/bin/voice-setup.sh
RUN export NIGHTLOOM_HOME=/opt/nightloom WHISPER_CMAKE_ARGS="-DGGML_NATIVE=OFF" \
 && bash /usr/local/bin/voice-setup.sh \
 && rm -rf /opt/nightloom/voice/fixtures \
 && find /opt/nightloom/voice/piper -name __pycache__ -prune -exec rm -rf {} + \
 && bash /usr/local/bin/voice-setup.sh --check

# ---- cli: the `nightloom` binary. The Linux credential store links libdbus (as CI's Linux leg). ----
FROM rust:1-bookworm AS cli
RUN apt-get update \
 && apt-get install -y --no-install-recommends libdbus-1-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# The desktop crate is a workspace member but is never built here (it needs the webview stack).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p nightloom-cli \
 && cp target/release/nightloom /usr/local/bin/nightloom

# ---- runtime ----
FROM debian:bookworm-slim AS runtime
# Claude Code CLI from Anthropic's signed apt repo, fingerprint checked (Keepsake's recipe:
# code.claude.com/docs/en/setup "Install with Linux package managers"). Rebuild to upgrade.
# git: Claude Code's tools use it in the work folder. python3 + libgomp1: Piper's venv and
# whisper-server (built with OpenMP) from the voice stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg libdbus-1-3 git \
      python3 libgomp1 \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://downloads.claude.ai/keys/claude-code.asc -o /etc/apt/keyrings/claude-code.asc \
 && gpg --show-keys --with-colons /etc/apt/keyrings/claude-code.asc \
      | grep -q '^fpr:::::::::31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE:' \
 && echo "deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main" \
      > /etc/apt/sources.list.d/claude-code.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends claude-code \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && claude --version

RUN useradd --create-home --uid 1000 nightloom
COPY --from=cli /usr/local/bin/nightloom /usr/local/bin/nightloom
COPY --from=page /src/apps/desktop/dist /app/dist
COPY --from=voice /opt/nightloom/voice /opt/nightloom/voice
# The venv's python3 is a link to /usr/bin/python3: the same bookworm Python as the voice stage's.
RUN /opt/nightloom/voice/piper/bin/python3 -c 'import piper' \
 && /opt/nightloom/voice/bin/whisper-server --help >/dev/null
COPY deploy/entrypoint.sh /usr/local/bin/nightloom-entrypoint
RUN chmod 0755 /usr/local/bin/nightloom-entrypoint

# Everything that must outlive a stopped machine is on the /data volume: the Nightloom home, the
# CLI's own HOME (its session files, which `--resume` reads), and the folder turns work in.
ENV NIGHTLOOM_HOME=/data/nightloom \
    HOME=/data/user \
    NIGHTLOOM_SERVE_PUBLIC=1 \
    NIGHTLOOM_SERVE_WORKSPACE=/data/work \
    DISABLE_AUTOUPDATER=1
EXPOSE 8080
ENTRYPOINT ["nightloom-entrypoint"]
