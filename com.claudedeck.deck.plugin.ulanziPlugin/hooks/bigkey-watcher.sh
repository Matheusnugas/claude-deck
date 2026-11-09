#!/bin/zsh
# Detached watcher: waits for Ulanzi Studio to quit, then patches the big key.
# Spawned by the plugin when the "Claude Screen Setup" action is on a key and
# the big key is not ours yet. Single instance, 2h timeout.
STATE_DIR="$HOME/Library/Application Support/Ulanzi/UlanziDeck/claude-state"
LOCK="$STATE_DIR/.bigkey-watcher.pid"
mkdir -p "$STATE_DIR"

# Patch on Studio's bundled Node (passed by the plugin) when available; python3
# is only the fallback — on a clean Mac /usr/bin/python3 is an installer stub.
# resolved here, not inside the function: in zsh $0 there is the function name
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
patch_bigkey() {
  local dir="$SCRIPT_DIR"
  if [[ -n "${CLAUDEDECK_NODE:-}" && -x "$CLAUDEDECK_NODE" && -f "$dir/patch-bigkey.mjs" ]]; then
    "$CLAUDEDECK_NODE" "$dir/patch-bigkey.mjs"
  elif [[ -x "/Applications/Ulanzi Studio.app/Contents/MacOS/NodeJS/node" && -f "$dir/patch-bigkey.mjs" ]]; then
    "/Applications/Ulanzi Studio.app/Contents/MacOS/NodeJS/node" "$dir/patch-bigkey.mjs"
  else
    python3 "$dir/patch-bigkey.py"
  fi
}

if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  exit 0  # already watching
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

end=$((SECONDS + 7200))
while pgrep -x UlanziDeck >/dev/null; do
  [ $SECONDS -ge $end ] && exit 1
  sleep 2
done

sleep 1  # let Studio finish writing profiles on its way out
patch_bigkey >> "$STATE_DIR/bigkey-watcher.log" 2>&1

# Reopen Studio ourselves: if the user reopens it manually before the patch
# lands, Studio reads the stale file and re-saves it later, undoing the change.
if ! pgrep -x UlanziDeck >/dev/null; then
  open -a "Ulanzi Studio"
fi
