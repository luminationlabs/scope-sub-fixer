#!/bin/sh
# Launch the built app on autopilot against a fresh fixture library and capture
# its window as it goes.
#
#   scripts/screenshots.sh <out-dir> [autopilot JSON overrides, e.g. '"cancelScanAfter":3']
#
# Needs: `pnpm tauri build --features autopilot` done (a normal release build
# ignores SCOPE_SUB_AUTOPILOT), ffmpeg + mkvmerge + bun (to make fixtures),
# and Screen Recording permission for whatever runs this (Terminal, usually).
# Every frame is kept as <out-dir>/frame-NNN.png; pick the ones worth keeping.
# Environment: WORK (scratch folder), BIG (see make-fixtures.ts), FIXTURE_SECONDS, PAUSE_MS,
# FRAMES, INTERVAL, EXPAND (which title's row to open at the end), APP (another
# build of the app binary to launch).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
desktop=$(dirname "$here")
out=${1:?usage: screenshots.sh <out-dir> [autopilot JSON overrides]}
extra=${2:-}
app=${APP:-"$desktop/src-tauri/target/release/bundle/macos/Scope Sub Fixer.app/Contents/MacOS/scope-sub-desktop"}
[ -x "$app" ] || { echo "build the app first: pnpm tauri build --features autopilot" >&2; exit 1; }

# WORK names the scratch folder (it shows in the screenshots); default a temp dir.
if [ -n "${WORK:-}" ]; then
  rm -rf "$WORK" && mkdir -p "$WORK" && work=$WORK
else
  work=$(mktemp -d "${TMPDIR:-/tmp}/scope-sub-shots.XXXXXX")
fi
mkdir -p "$out"
echo "fixtures → $work"
bun "$here/make-fixtures.ts" "$work" "${FIXTURE_SECONDS:-8}" >/dev/null

script="{\"library\":\"$work/Movies\",\"output\":\"$work/Fixed\",\"pauseMs\":${PAUSE_MS:-2500},\"expandTitle\":\"${EXPAND:-Mad Max}\"${extra:+,$extra}}"
SCOPE_SUB_AUTOPILOT="$script" "$app" >"$work/app.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT

id=""
for _ in $(seq 1 50); do
  id=$(swift "$here/window-id.swift" "$pid" 2>/dev/null || true)
  [ -n "$id" ] && break
  sleep 0.2
done
[ -n "$id" ] || { echo "the app's window never appeared; see $work/app.log" >&2; exit 1; }
echo "window $id (pid $pid)"

n=0
while [ $n -lt "${FRAMES:-60}" ] && kill -0 $pid 2>/dev/null; do
  screencapture -x -o -l "$id" "$out/$(printf 'frame-%03d.png' $n)" || true
  n=$((n + 1))
  sleep "${INTERVAL:-0.25}"
done
echo "$n frame(s) in $out; work dir $work"
