#!/bin/sh
# Install (or repair) ClearNote on a Mac:
#   curl -fsSL https://raw.githubusercontent.com/professor-durian/clearnote/main/tools/install-mac.sh | sh
#
# Puts ClearNote in ~/code/clearnote, starts its server at login, and opens the
# extension folder so you can load it in Chrome. Safe to run again.
set -eu

REPO="${CLEARNOTE_REPO:-https://github.com/professor-durian/clearnote.git}"
DIR="${CLEARNOTE_DIR:-$HOME/code/clearnote}"
ENV_FILE="$HOME/.clearnote.env"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n%s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is missing. Run: xcode-select --install   then run this again."

# Node: Homebrew's, nvm's or anything on PATH, version 22 or newer.
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  if command -v brew >/dev/null 2>&1; then
    say "Installing Node.js with Homebrew"
    brew install node
    NODE="$(command -v node)"
  else
    fail "Node.js is missing. Install it from https://nodejs.org (LTS), then run this again."
  fi
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 22 ] || fail "Node.js $MAJOR is too old; ClearNote needs 22 or newer."

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  # npm may have rewritten the package lock on an earlier run; that isn't yours.
  git -C "$DIR" checkout -- server/package-lock.json 2>/dev/null || true
  git -C "$DIR" pull --ff-only
else
  say "Downloading ClearNote to $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO" "$DIR"
fi

say "Installing the server's packages"
cd "$DIR/server"
# ci installs exactly what the lock file lists and leaves it unchanged, so
# later one-click updates don't see a local change.
PATH="$(dirname "$NODE"):$PATH" npm ci --omit=dev --no-audit --no-fund

# launchd starts with no PATH: remember which Node to use.
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
if grep -q '^CLEARNOTE_NODE=' "$ENV_FILE"; then
  sed -i '' "s|^CLEARNOTE_NODE=.*|CLEARNOTE_NODE=$NODE|" "$ENV_FILE"
else
  echo "CLEARNOTE_NODE=$NODE" >> "$ENV_FILE"
fi

say "Starting the server at login"
sh "$DIR/server/install-agent.sh"

for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS --max-time 2 http://localhost:8787/api/health >/dev/null 2>&1 && break
  sleep 1
done

say "Last step, in Chrome"
cat <<EOF
  1. Open chrome://extensions and turn on Developer mode (top right).
  2. Click "Load unpacked" and choose: $DIR/extension
     (a Finder window with that folder is opening now)
  3. Open http://localhost:8787 › Settings:
     - Connections: paste the same Google client ID and secret as your other
       computer, then Connect Google with the same account. Your meetings from
       other computers appear within a few minutes.
     - AI: paste your Anthropic or OpenRouter key.
  Later updates: a banner in the dashboard offers them; one click installs.
EOF
open "$DIR/extension" 2>/dev/null || true
open "http://localhost:8787/#/settings/connections" 2>/dev/null || true
