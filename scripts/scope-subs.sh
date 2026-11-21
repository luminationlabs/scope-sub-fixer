#!/bin/bash
# Scope Subs: check the library for new titles, and fix — one yes/no at a
# time, in place — the ones whose PGS subtitles sit in the letterbox bars.
# Then copy the library's plan (its check record and undo record) to a second
# place — also when the check is interrupted (Ctrl-C, or the window closed):
# titles fixed before that have their undo record in the plan, and it must not
# stay on this Mac alone.
#
# The plan is the only way back for every file ever fixed, so nothing here can
# make a copy of it worse:
#   - nothing is ever deleted from a copy except whole snapshots, oldest first;
#   - before anything is copied from the plan — and again after the check — the
#     plan must pass check_plan below: readable, every patch file present, and
#     not smaller than the newest snapshot or the mirror's copy;
#   - a tool that cannot run is reported as that, never as a damaged plan.
#
# Run in a Terminal window by the "Scope Subs" app (scripts/scope-subs.applescript).
# Shipped in the package so a deploy updates it too.
#
# Settings, as environment variables or as lines in ~/.config/scope-subs/config
# (a shell file read at start; the environment wins):
#
#   SCOPE_SUBS_LIBRARY  the library to check. Required. Must be a mount point:
#                       an unmounted share is an empty local folder, and is
#                       refused.
#   SCOPE_SUBS_PLAN     the plan kept for it. Required. In a folder of its own:
#                       the snapshots go in logs/ beside it.
#   SCOPE_SUBS_MIRROR   a folder of its own, on another filesystem, that the
#                       plan and its snapshots are copied to. Optional; without
#                       it the plan is not copied anywhere.
#   SCOPE_SUBS_PRESERVE_DATES  set to 1 to put each file's modification date
#                       back after it is repaired, so a media server does not
#                       list it as newly added. Optional; off by default.
#
# macOS /bin/bash is 3.2 and /usr/bin/rsync is openrsync: nothing newer than
# either understands is used here.

set -u
export PATH="$HOME/Scripts/scope-sub/npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# For scripts/deploy.sh: it runs `doctor` under exactly this PATH.
if [ "${1:-}" = "--print-path" ]; then
  printf '%s\n' "$PATH"
  exit 0
fi

# The config file sets what the environment has not.
CONFIG="$HOME/.config/scope-subs/config"
env_library="${SCOPE_SUBS_LIBRARY-}" env_plan="${SCOPE_SUBS_PLAN-}"
env_mirror_set="${SCOPE_SUBS_MIRROR+set}" env_mirror="${SCOPE_SUBS_MIRROR-}"
env_dates_set="${SCOPE_SUBS_PRESERVE_DATES+set}" env_dates="${SCOPE_SUBS_PRESERVE_DATES-}"
if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi
LIBRARY="${env_library:-${SCOPE_SUBS_LIBRARY-}}"
PLAN="${env_plan:-${SCOPE_SUBS_PLAN-}}"
if [ -n "$env_mirror_set" ]; then MIRROR="$env_mirror"; else MIRROR="${SCOPE_SUBS_MIRROR-}"; fi
# `scope-subs.sh --remargin`: instead of the check, redo the repairs made with
# an earlier margin (`scope-sub remargin`) — under the same lock, with the same
# snapshot before and the same copy to the mirror after.
if [ -n "$env_dates_set" ]; then DATES="$env_dates"; else DATES="${SCOPE_SUBS_PRESERVE_DATES-}"; fi
# Empty or "--preserve-dates"; expanded unquoted below, on purpose.
DATES_FLAG=""
if [ "$DATES" = 1 ]; then DATES_FLAG="--preserve-dates"; fi
# `scope-subs.sh --restore-dates`: instead of the check, put back the dates of
# the files repaired before SCOPE_SUBS_PRESERVE_DATES was set
# (`scope-sub restore-dates`). Same lock, snapshot and mirror.
MODE=review
if [ "${1:-}" = "--remargin" ]; then MODE=remargin; fi
if [ "${1:-}" = "--restore-dates" ]; then MODE=dates; fi

LOCK="${TMPDIR:-/tmp}/scope-subs.lock"
KEEP=10 # snapshots kept, here and in the mirror

finish() {
  echo
  read -r -p "Press ENTER to close..." _ || true
  exit "$1"
}

device() { stat -f %d "$1" 2>/dev/null; }

# The physical path of a directory (no symlinks, no "." or ".."), or nothing.
canon() { (cd "$1" 2>/dev/null && pwd -P); }

# --- one run at a time ------------------------------------------------------
# Two would plan and patch the same files at once. The lock is a symlink whose
# target is the holder's pid: made in one step, so there is never a lock without
# its pid.

lock_pid() {
  readlink "$1" 2>/dev/null
}

# Is that pid a running Scope Subs? Not merely alive: pids are reused.
holder_runs() {
  local running
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  running="$(ps -p "$1" -o command= 2>/dev/null)"
  case $? in
    0) case "$running" in *scope-subs.sh*) return 0 ;; *) return 1 ;; esac ;;
    1) return 1 ;;
    *) kill -0 "$1" 2>/dev/null ;; # ps itself cannot run: err towards "running"
  esac
}

# 0: the lock is ours. 1: another run holds it (LOCK_HOLDER). 2: cannot take it.
take_lock() {
  local tries=0 other clearing="$LOCK.clearing"
  while [ "$tries" -lt 50 ]; do
    tries=$((tries + 1))
    # (ln onto a directory would make the link inside it.)
    if [ -L "$LOCK" ] || [ ! -d "$LOCK" ]; then
      ln -s "$$" "$LOCK" 2>/dev/null && return 0
    fi
    other="$(lock_pid "$LOCK")"
    if holder_runs "$other"; then
      LOCK_HOLDER="$other"
      return 1
    fi
    # Stale. Several runs started together all see that, and a run that removed
    # "the stale lock" a moment after another had replaced it would remove a
    # live one. So only one run at a time may clear it — a second link says
    # which — and that run judges the lock again once it is alone. A lock is
    # only ever made by the ln above, which cannot succeed while one exists.
    if ln -s "$$" "$clearing" 2>/dev/null; then
      other="$(lock_pid "$LOCK")"
      holder_runs "$other" || rm -rf "$LOCK"
      rm -f "$clearing"
    elif ! holder_runs "$(readlink "$clearing" 2>/dev/null)"; then
      rm -f "$clearing" # left by a run that died between the lines above
    else
      sleep 0.2
    fi
  done
  return 2
}

if [ -z "$LIBRARY" ] || [ -z "$PLAN" ]; then
  echo "Scope Subs is not configured: the library and plan locations are required."
  echo "Add these lines to $CONFIG:"
  echo '  SCOPE_SUBS_LIBRARY="/path/to/your/movies"'
  echo '  SCOPE_SUBS_PLAN="$HOME/scope-sub/library"'
  echo '  SCOPE_SUBS_MIRROR="/path/on/another/disk/scope-sub"   # optional'
  echo "Nothing was scanned."
  finish 1
fi

take_lock
case $? in
  0) ;;
  1)
    echo "Scope Subs is already running (process $LOCK_HOLDER). Wait for it to finish."
    finish 1
    ;;
  *)
    echo "Could not acquire the lock at $LOCK."
    finish 1
    ;;
esac
trap '[ "$(lock_pid "$LOCK")" = "$$" ] && rm -f "$LOCK"' EXIT

# --- the tool itself --------------------------------------------------------
# Checked before the plan is, and said apart from it: when node or scope-sub is
# missing or broken, every check of the plan fails too, and "the plan is
# damaged, restore a copy" would be exactly the wrong advice.

tool_ok() {
  local out
  TOOL_PROBLEM=""
  if ! command -v node >/dev/null 2>&1; then
    TOOL_PROBLEM="node was not found (looked in $PATH)"
    return 1
  fi
  if ! command -v scope-sub >/dev/null 2>&1; then
    TOOL_PROBLEM="scope-sub was not found (looked in $PATH)"
    return 1
  fi
  if ! out="$(scope-sub --version 2>&1)"; then
    TOOL_PROBLEM="scope-sub failed to start: $(printf '%s\n' "$out" | tail -1)"
    return 1
  fi
}

if ! tool_ok; then
  echo "Scope Subs cannot run: $TOOL_PROBLEM."
  echo "This is an installation problem, not a plan problem. Nothing was scanned"
  echo "or copied, and nothing needs to be restored. Reinstall Node or redeploy"
  echo "scope-sub (scripts/deploy.sh), then try again."
  finish 1
fi

# --- the library ------------------------------------------------------------
# A share that is not mounted leaves an empty local folder behind, writable
# and all: check that the library really is its own filesystem.
library="$(canon "$LIBRARY")"
if [ -z "$library" ] || [ "$(device "$library")" = "$(device "$library/..")" ]; then
  echo "$LIBRARY is not mounted."
  echo "Mount it and try again."
  finish 1
fi
LIBRARY="$library"
if [ ! -w "$LIBRARY" ]; then
  echo "$LIBRARY is mounted read-only. Fixing requires read-write access."
  finish 1
fi

# --- the plan, and where its copies go ---------------------------------------
# Without its plan the first run would analyze the whole library (hours) into
# a new plan that knows nothing of what was already repaired. Never start one
# by accident.
if [ ! -f "$PLAN/plan.json" ]; then
  echo "No plan found at $PLAN."
  echo "The plan records what has been scanned and holds the undo data for every"
  echo "fix. Restore it (the mirror at ${MIRROR:-<none>} has a copy) before scanning."
  finish 1
fi
PLAN="$(canon "$PLAN")"
FOLDER="$(dirname "$PLAN")"
BASE="$(basename "$PLAN")"
LOGS="$FOLDER/logs"
if [ "$FOLDER" = / ] || [ "$FOLDER" = "$(canon "$HOME")" ] || [ "$PLAN" = "$(canon "$HOME")" ] || [ "$BASE" = logs ]; then
  echo "The plan at $PLAN must be inside its own folder (snapshots are kept in"
  echo "logs/ beside it), for example ~/scope-sub/library. Nothing was scanned."
  finish 1
fi

# Where the mirror really is, and whether it may be written. Sets MIRROR_DIR, or
# MIRROR_WHY (why not). Asked again after the check: shares come and go.
resolve_mirror() {
  local parent base
  MIRROR_DIR=""
  MIRROR_WHY=""
  [ -n "$MIRROR" ] || return 1
  if [ -d "$MIRROR" ]; then
    MIRROR_DIR="$(canon "$MIRROR")"
  else
    parent="$(canon "$(dirname "$MIRROR")")"
    base="$(basename "$MIRROR")"
    if [ -z "$parent" ] || [ "$base" = . ] || [ "$base" = .. ]; then
      MIRROR_WHY="$MIRROR was not found (check that the share is mounted)"
      return 1
    fi
    MIRROR_DIR="${parent%/}/$base"
  fi
  parent="$(dirname "$MIRROR_DIR")"
  if [ -z "$MIRROR_DIR" ] || [ "$MIRROR_DIR" = / ] ||
    { [ -d "$MIRROR_DIR" ] && [ "$(device "$MIRROR_DIR")" != "$(device "$parent")" ]; }; then
    MIRROR_WHY="$MIRROR is the root of a share or disk; set SCOPE_SUBS_MIRROR to a dedicated folder inside it"
  elif [ "$(device "$parent")" = "$(device "$FOLDER")" ]; then
    # Not mounted (an empty local folder), or simply not a second place.
    MIRROR_WHY="$parent is not a mounted share (it is on the same disk as the plan)"
  else
    case "$MIRROR_DIR/" in "$FOLDER"/*) MIRROR_WHY="$MIRROR is inside the plan's own folder" ;; esac
    case "$FOLDER/" in "$MIRROR_DIR"/*) MIRROR_WHY="the plan's folder is inside $MIRROR" ;; esac
  fi
  if [ -n "$MIRROR_WHY" ]; then
    MIRROR_DIR=""
    return 1
  fi
}

# The newest snapshot.
newest_snapshot() {
  local d newest=""
  for d in "$LOGS"/before-check-????????T??????Z; do
    [ -d "$d" ] && [ ! -L "$d" ] && newest="$d"
  done
  printf '%s' "$newest"
}

# What a plan must be before anything is copied from it. A plan.json that
# parses is not enough: a plan emptied by a stray command, or one that lost a
# patch file or its log, parses too — and copying that over the good copies
# would leave no way back. Arguments: the plan, then the copies to compare with
# (ones that hold no plan.json are skipped). Prints what is wrong; exit 1.
read -r -d '' CHECK_JS <<'JS'
const fs = require("fs");
const path = require("path");
const [live, ...refs] = process.argv.slice(1);
const temp = (name) => /\.tmp-\d+$/.test(name);
const problems = [];
const notes = [];

function load(dir) {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.files)) {
    throw new Error("plan.json has no list of titles");
  }
  let patches = [];
  try {
    patches = fs
      .readdirSync(path.join(dir, "patches"))
      .filter((name) => name.endsWith(".json") && !temp(name));
  } catch {}
  let log = null;
  try {
    log = fs.statSync(path.join(dir, "apply.log.jsonl")).size;
  } catch {}
  return { titles: plan.files, patches: new Set(patches), log };
}

function few(names) {
  return names.slice(0, 5).join(", ") + (names.length > 5 ? `, and ${names.length - 5} more` : "");
}

let mine;
try {
  mine = load(live);
} catch (err) {
  console.log(`plan.json cannot be read: ${err.message}`);
  process.exit(1);
}

const missing = [];
const broken = [];
for (const title of mine.titles) {
  if (title === null || typeof title !== "object" || typeof title.patchFile !== "string") continue;
  let text;
  try {
    text = fs.readFileSync(path.join(live, title.patchFile), "utf8");
  } catch {
    missing.push(title.patchFile);
    continue;
  }
  try {
    JSON.parse(text);
  } catch {
    broken.push(title.patchFile);
  }
}
if (missing.length > 0) {
  problems.push(`${missing.length} patch file(s) the plan names are missing: ${few(missing)}`);
}
if (broken.length > 0) {
  problems.push(`${broken.length} patch file(s) are not readable JSON: ${few(broken)}`);
}

for (const ref of refs) {
  if (ref === "" || !fs.existsSync(path.join(ref, "plan.json"))) continue;
  let copy;
  try {
    copy = load(ref);
  } catch (err) {
    notes.push(`note: the copy at ${ref} cannot be read itself (${err.message}); not compared`);
    continue;
  }
  if (mine.titles.length < copy.titles.length) {
    problems.push(
      `plan.json lists ${mine.titles.length} title(s); the copy at ${ref} lists ${copy.titles.length}`,
    );
  }
  const lost = [...copy.patches].filter((name) => !mine.patches.has(name)).sort();
  if (lost.length > 0) {
    problems.push(
      `${lost.length} patch file(s) in the copy at ${ref} are no longer in patches/: ${few(lost)}`,
    );
  }
  if (copy.log !== null && mine.log === null) {
    problems.push(`apply.log.jsonl is missing; the copy at ${ref} has one`);
  } else if (copy.log !== null && mine.log < copy.log) {
    problems.push(
      `apply.log.jsonl (${mine.log} bytes) is shorter than in the copy at ${ref} ` +
        `(${copy.log} bytes); the log should only grow`,
    );
  }
}

for (const line of [...problems, ...notes]) console.log(line);
process.exit(problems.length > 0 ? 1 : 0);
JS

# 0: sound (PLAN_REPORT may hold notes). 1: not sound; PLAN_REPORT says why.
# 2: the check itself could not run.
check_plan() {
  local out
  if ! out="$(scope-sub plan-show "$PLAN" --only fix 2>&1 >/dev/null)"; then
    PLAN_REPORT="$(printf '%s\n' "$out" | tail -3)"
    return 1
  fi
  PLAN_REPORT="$(node -e "$CHECK_JS" "$PLAN" "$@" 2>&1)"
  case $? in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

good_copies() {
  local newest
  newest="$(newest_snapshot)"
  echo "Good copies: ${newest:-<no snapshot yet>} (the newest snapshot; older ones beside it)"
  if [ -n "$MIRROR" ]; then
    echo "             $MIRROR/$BASE (as of the last mirrored run)"
  fi
  echo "If this plan is correct and a copy is the one that differs, move that copy aside."
}

resolve_mirror
check_plan "$(newest_snapshot)" ${MIRROR_DIR:+"$MIRROR_DIR/$BASE"}
case $? in
  0) [ -n "$PLAN_REPORT" ] && echo "$PLAN_REPORT" ;;
  1)
    echo "The plan at $PLAN failed its integrity check. Nothing was scanned or copied."
    printf '%s\n' "$PLAN_REPORT" | sed 's/^/  - /'
    good_copies
    finish 1
    ;;
  *)
    echo "Scope Subs cannot run: the plan integrity check could not be run."
    printf '%s\n' "$PLAN_REPORT" | tail -3
    echo "This is an installation problem, not a plan problem. Nothing was scanned"
    echo "or copied, and nothing needs to be restored."
    finish 1
    ;;
esac

# --- a snapshot from before this check ---------------------------------------
# The whole plan — plan.json, its log and its patch files, which a check can
# rewrite — as it is now, in a folder of its own named for the time. Only a
# plan that passed the check above gets here, an unchanged plan is not copied
# again, and the oldest snapshots beyond $KEEP are the only thing ever removed.

same_as_plan() { diff -rq -x '*.tmp-*' "$PLAN" "$1" >/dev/null 2>&1; }

prune_snapshots() {
  local d n=0 gone=0
  for d in "$1"/before-check-????????T??????Z; do
    [ -d "$d" ] && [ ! -L "$d" ] && n=$((n + 1))
  done
  for d in "$1"/before-check-????????T??????Z; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    [ $((n - gone)) -le "$KEEP" ] && break
    rm -rf "$d"
    gone=$((gone + 1))
  done
}

take_snapshot() {
  local newest stamp partial
  newest="$(newest_snapshot)"
  case "$newest" in
    */before-check-*)
      if same_as_plan "$newest"; then
        SNAPSHOT="$newest"
        return 0
      fi
      ;;
  esac
  mkdir -p "$LOGS" || return 1
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  if [ -e "$LOGS/before-check-$stamp" ]; then
    sleep 1
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  # Built under another name, so a copy cut short is never taken for a snapshot.
  partial="$LOGS/.before-check-$stamp.partial"
  rm -rf "$partial"
  if rsync -rt -x --exclude='*.tmp-*' "$PLAN/" "$partial/" && same_as_plan "$partial" &&
    mv "$partial" "$LOGS/before-check-$stamp"; then
    SNAPSHOT="$LOGS/before-check-$stamp"
    prune_snapshots "$LOGS"
    return 0
  fi
  rm -rf "$partial"
  return 1
}

if ! take_snapshot; then
  echo "Could not save a snapshot of the plan in $LOGS. Not scanning without one."
  finish 1
fi

# --- the check ---------------------------------------------------------------
# From here an interrupt must not end the script: the tool is stopped by the
# same signal, and what it had already fixed still has to reach the mirror.
# (A handler, not "ignore": an ignored signal would be ignored by the tool too.)
interrupted=0
trap 'interrupted=1' INT TERM HUP

if [ "$MODE" = remargin ]; then
  # A dry run first: it says what would be redone, and changes nothing.
  scope-sub remargin "$LIBRARY" --recursive --plan "$PLAN" $DATES_FLAG
  status=$?
  if [ "$status" -eq 0 ] && [ "$interrupted" -eq 0 ]; then
    echo
    answer=""
    read -r -p "Redo these fixes in place now? [y/n] " answer || answer=n
    case "$answer" in
      y | Y | yes | YES)
        scope-sub remargin "$LIBRARY" --recursive --plan "$PLAN" --execute $DATES_FLAG
        status=$?
        ;;
      *) echo "No files were modified." ;;
    esac
  fi
elif [ "$MODE" = dates ]; then
  # A dry run first: it lists each date and what it would become.
  scope-sub restore-dates "$PLAN"
  status=$?
  if [ "$status" -eq 0 ] && [ "$interrupted" -eq 0 ]; then
    echo
    answer=""
    read -r -p "Restore these dates now? [y/n] " answer || answer=n
    case "$answer" in
      y | Y | yes | YES)
        scope-sub restore-dates "$PLAN" --execute
        status=$?
        ;;
      *) echo "No files were modified." ;;
    esac
  fi
else
  scope-sub review "$LIBRARY" --recursive --plan "$PLAN" $DATES_FLAG
  status=$?
fi

# And from here they are ignored: a second Ctrl-C used to stop the check of the
# plan below, which then read as "damaged" and kept the mirror from being
# written. (Ctrl-\ still stops a copy to a share that hangs.)
trap '' INT TERM HUP

if [ "$interrupted" -ne 0 ]; then
  echo
  echo "Interrupted. A fix in progress is completed or reverted on the next run."
  [ "$status" -eq 0 ] && status=130
fi

# --- the mirror --------------------------------------------------------------
# Additive: the plan directory and the snapshots, each into its own folder of
# the mirror, nothing deleted there but snapshots beyond $KEEP, no mount point
# crossed. Only a plan that passes the same check as before the run is copied.

copy_to_mirror() {
  local d
  mkdir -p "$MIRROR_DIR/logs" || return 1
  rsync -rt -x --exclude='*.tmp-*' "$PLAN/" "$MIRROR_DIR/$BASE/" || return 1
  for d in "$LOGS"/before-check-????????T??????Z; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    rsync -rt -x "$d/" "$MIRROR_DIR/logs/$(basename "$d")/" || return 1
  done
  prune_snapshots "$MIRROR_DIR/logs"
}

if [ -n "$MIRROR" ]; then
  echo
  if ! tool_ok; then
    echo "WARNING: scope-sub failed to run ($TOOL_PROBLEM). The plan was not"
    echo "verified and was NOT copied to $MIRROR. This is an installation problem,"
    echo "not a plan problem. Fix it and run again."
    [ "$status" -eq 0 ] && status=1
  elif ! resolve_mirror; then
    echo "WARNING: $MIRROR_WHY."
    echo "The plan was not copied there. Its undo data exists only on this Mac."
  else
    check_plan "$SNAPSHOT" "$MIRROR_DIR/$BASE"
    case $? in
      0)
        [ -n "$PLAN_REPORT" ] && echo "$PLAN_REPORT"
        if copy_to_mirror; then
          echo "Copied the plan and its snapshots to $MIRROR_DIR."
        else
          echo "WARNING: copying the plan to $MIRROR_DIR failed. The undo data exists only on this Mac."
          [ "$status" -eq 0 ] && status=1
        fi
        ;;
      1)
        echo "WARNING: the plan at $PLAN failed its integrity check after this run. It was"
        echo "NOT copied to $MIRROR_DIR, which is unchanged."
        printf '%s\n' "$PLAN_REPORT" | sed 's/^/  - /'
        echo "$SNAPSHOT holds the plan as it was before this run."
        [ "$status" -eq 0 ] && status=1
        ;;
      *)
        echo "WARNING: the plan integrity check could not be run. The plan was NOT copied to $MIRROR_DIR."
        printf '%s\n' "$PLAN_REPORT" | tail -3
        echo "This is an installation problem, not a plan problem."
        [ "$status" -eq 0 ] && status=1
        ;;
    esac
  fi
fi

finish "$status"
