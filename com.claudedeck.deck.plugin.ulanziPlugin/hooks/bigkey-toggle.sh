#!/bin/zsh
# Full automatic big-key toggle: quit Studio, patch to the desired state,
# relaunch. Spawned detached by the plugin when the setup key is pressed.
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
exec >> "$STATE_DIR/bigkey-watcher.log" 2>&1
echo "=== toggle $(date '+%H:%M:%S') pid $$"

if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  echo "another toggle in progress, exiting"
  exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

osascript -e 'tell application "Ulanzi Studio" to quit' 2>/dev/null || true

# wait for Studio to exit (force-kill escape hatch after 30s)
end=$((SECONDS + 30))
while pgrep -x UlanziDeck >/dev/null; do
  if [ $SECONDS -ge $end ]; then
    echo "quit timeout, force killing"
    pkill -x UlanziDeck 2>/dev/null || true
    sleep 2
    break
  fi
  sleep 1
done
echo "studio exited"

sleep 1  # let profile writes settle
patch_bigkey

# relaunch with retries
for i in 1 2 3; do
  open -a "Ulanzi Studio" && echo "open attempt $i issued"
  sleep 6
  if pgrep -x UlanziDeck >/dev/null; then
    echo "studio relaunched"
    exit 0
  fi
done
echo "RELAUNCH FAILED after 3 attempts"
