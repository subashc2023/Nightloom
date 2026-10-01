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
# git: Claude Code's tools use it in the work folder.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg libdbus-1-3 git \
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
COPY deploy/entrypoint.sh /usr/local/bin/nightloom-entrypoint
RUN chmod 0755 /usr/local/bin/nightloom-entrypoint

# Everything that must outlive a stopped machine is on the /data volume: the Nightloom home, the
# CLI's own HOME (its session files, which `--resume` reads), and the folder turns work in.
ENV NIGHTLOOM_HOME=/data/nightloom \
    HOME=/data/user \
    NIGHTLOOM_SERVE_PUBLIC=1 \
    DISABLE_AUTOUPDATER=1
EXPOSE 8080
ENTRYPOINT ["nightloom-entrypoint"]
