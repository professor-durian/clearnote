#!/bin/sh
# Entry point for the launchd agent (and fine to run by hand).
#
# launchd starts processes with almost no environment — no PATH from your
# shell, no exported secrets — so this script supplies both: it reads the
# key file, then execs node by absolute path.
set -u

ENV_FILE="${CLEARNOTE_ENV:-$HOME/.clearnote.env}"
# Read the env file first, so CLEARNOTE_NODE set there is honoured below.
# Secrets live outside the project directory, in a file only you can read, so
# they are never near anything that gets copied or committed.
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
else
  echo "[clearnote] no $ENV_FILE — starting without an API key or calendar credentials"
fi

if [ -n "${CLEARNOTE_NODE:-}" ]; then
  NODE="$CLEARNOTE_NODE"
else
  # launchd has no shell PATH, so check the usual install locations by hand.
  NODE=""
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.nvm/current/bin/node"; do
    if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
  [ -n "$NODE" ] || NODE="$(command -v node 2>/dev/null || true)"
fi

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"
export PORT

# Someone running `npm start` in a terminal already holds the port. Exit
# successfully rather than crash-looping against them: KeepAlive only restarts
# on a failure, so a clean exit here means the agent simply stands aside.
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "[clearnote] a server is already listening on $PORT — leaving it alone"
  exit 0
fi

if [ ! -x "$NODE" ]; then
  echo "[clearnote] node not found at $NODE — set CLEARNOTE_NODE in $ENV_FILE"
  exit 1
fi

echo "[clearnote] starting on port $PORT at $(date)"
exec "$NODE" server.js
