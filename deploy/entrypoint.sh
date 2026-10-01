#!/bin/sh
# Runs as root: make the volume's folders (Fly mounts it root-owned), then exec `nightloom serve`
# as the unprivileged `nightloom` user, so Fly's stop signal (SIGINT) reaches it directly.
# NIGHTLOOM_REMOTE_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are Fly secrets; NIGHTLOOM_SERVE_MODEL is in fly.toml.
set -e
mkdir -p /data/nightloom /data/user /data/work
chown nightloom:nightloom /data /data/nightloom /data/user /data/work
cd /data/work
if [ -n "$NIGHTLOOM_SERVE_MODEL" ]; then
  set -- --model "$NIGHTLOOM_SERVE_MODEL" "$@"
fi
exec setpriv --reuid=nightloom --regid=nightloom --init-groups \
  nightloom serve --ip 0.0.0.0 --port 8080 --assets /app/dist "$@"
