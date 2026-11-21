#!/bin/sh
# Deploy scope-sub to another machine over ssh.
#
#   scripts/deploy.sh user@nas
#   scripts/deploy.sh user@nas --dir /volume1/scope-sub --dry-run
#
# What it does, in order:
#   1. `pnpm pack` here, producing scope-sub-<version>.tgz;
#   2. scp the tarball to <dir> on the remote (created if missing);
#   3. install it there with npm -g — system-wide when the remote user is root,
#      otherwise into <dir>/npm-global, with the PATH line printed — after
#      refusing (exit 4) while the Scope Subs app is running there: a run must
#      not have the tool replaced under it;
#   4. check that what is installed now reports the version just packed
#      (exit 5 otherwise), run `scope-sub doctor` remotely and pass its exit
#      status through. On a Mac both run under exactly the PATH the Scope Subs
#      app uses (scripts/scope-subs.sh --print-path), so a node that only an
#      ssh session can find fails here and not at the next double-click.
#
# The remote needs Node >= 22.12, npm, mkvmerge, mkvextract and ffmpeg. Step 4
# is what tells you whether it does. Nothing here touches any media.
#
# POSIX sh: no arrays, no bashisms.

set -eu

REMOTE=""
DIR="~/Scripts/scope-sub"
DRY_RUN=0
SSH_OPTS=${SCOPE_SUB_SSH_OPTS:-}

usage() {
  cat <<'USAGE'
usage: scripts/deploy.sh <user@host> [--dir <remote dir>] [--dry-run]

  --dir <path>   remote install directory (default: ~/Scripts/scope-sub)
  --dry-run      print every command instead of running the remote ones
  -h, --help     this message

Environment:
  SCOPE_SUB_SSH_OPTS   extra options passed to ssh and scp (e.g. "-p 2222")
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || { echo "deploy: --dir needs a value" >&2; exit 2; }
      DIR="$2"
      shift 2
      ;;
    --dir=*)
      DIR="${1#--dir=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "deploy: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$REMOTE" ]; then
        echo "deploy: unexpected argument $1" >&2
        exit 2
      fi
      REMOTE="$1"
      shift
      ;;
  esac
done

if [ -z "$REMOTE" ]; then
  echo "deploy: a <user@host> target is required" >&2
  usage >&2
  exit 2
fi

REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_DIR"

VERSION=$(node -p "require('./package.json').version")
TARBALL="scope-sub-${VERSION}.tgz"

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# Print a command, then run it unless --dry-run.
run() {
  printf '   $ %s\n' "$*"
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  # shellcheck disable=SC2294
  eval "$@"
}

# The remote half, run through `sh -s`. $1 is the remote directory, $2 the
# tarball name, $3 the version it holds. Kept as one script so a single ssh
# round trip does everything.
remote_script() {
  cat <<'REMOTE_SH'
set -eu
# Non-interactive ssh shells get a minimal PATH; make Homebrew / local
# installs of node, npm, mkvmerge and ffmpeg visible to npm and doctor.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
DIR="$1"
TARBALL="$2"
VERSION="$3"
# The directory arrives quoted, so a leading ~ is still literal here.
case "$DIR" in
  "~") DIR="$HOME" ;;
  "~/"*) DIR="$HOME/${DIR#"~/"}" ;;
esac
mkdir -p "$DIR"
cd "$DIR"

command -v node >/dev/null 2>&1 || { echo "remote: node is not installed" >&2; exit 3; }
command -v npm  >/dev/null 2>&1 || { echo "remote: npm is not installed" >&2; exit 3; }

# 22.12 is what the one runtime dependency (commander 15) needs.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'; then
  echo "remote: node $(node -v) is too old; scope-sub needs >= 22.12" >&2
  exit 3
fi

# npm replaces the whole package directory: not under a running Scope Subs,
# whose later steps (and its copy of the plan to the mirror) need the tool.
if ps -axo command= 2>/dev/null | grep 'bash .*scope-subs\.sh' >/dev/null 2>&1; then
  echo "remote: Scope Subs is running on this machine. Let it finish and deploy again;" >&2
  echo "remote: nothing was installed." >&2
  exit 4
fi

# </dev/null: this script arrives on stdin, and nothing here may read it.
if [ "$(id -u)" = "0" ]; then
  echo "remote: installing system-wide"
  npm install -g "./$TARBALL" </dev/null
  BIN="$(command -v scope-sub || echo /usr/local/bin/scope-sub)"
  PACKAGE="$(npm root -g </dev/null)/scope-sub"
else
  PREFIX="$DIR/npm-global"
  echo "remote: not root; installing into $PREFIX"
  mkdir -p "$PREFIX"
  npm install -g --prefix "$PREFIX" "./$TARBALL" </dev/null
  BIN="$PREFIX/bin/scope-sub"
  PACKAGE="$PREFIX/lib/node_modules/scope-sub"
  echo
  echo "Add this to the remote shell profile to get scope-sub on PATH:"
  echo "  export PATH=\"$PREFIX/bin:\$PATH\""
fi

# On a Mac the Scope Subs app runs the tool under a PATH of its own. Everything
# below runs under exactly that one, so what passes here is what the app gets.
APP_SCRIPT="$PACKAGE/scripts/scope-subs.sh"
if [ "$(uname -s)" = "Darwin" ] && [ -f "$APP_SCRIPT" ]; then
  APP_PATH="$(/bin/bash "$APP_SCRIPT" --print-path </dev/null)"
  [ -n "$APP_PATH" ] || { echo "remote: $APP_SCRIPT did not print its PATH" >&2; exit 5; }
  PATH="$APP_PATH"
  export PATH
  echo
  echo "remote: checking under the Scope Subs app's PATH ($PATH)"
  FOUND="$(command -v scope-sub || true)"
  if [ -z "$FOUND" ]; then
    echo "remote: WARNING: the Scope Subs app would not find scope-sub: it looks in" >&2
    echo "remote: ~/Scripts/scope-sub/npm-global/bin, and this install is in $DIR." >&2
  elif [ "$(cd "$(dirname "$FOUND")" && pwd -P)" != "$(cd "$(dirname "$BIN")" && pwd -P)" ]; then
    echo "remote: the Scope Subs app would run $FOUND, not the $BIN just installed" >&2
    exit 5
  fi
fi

# An install that quietly left the old build in place must not pass for a deploy.
if ! INSTALLED="$("$BIN" --version 2>&1 </dev/null)"; then
  echo "remote: $BIN does not start: $INSTALLED" >&2
  exit 5
fi
if [ "$INSTALLED" != "$VERSION" ]; then
  echo "remote: $BIN reports version $INSTALLED, not the $VERSION just packed;" >&2
  echo "remote: the install did not take." >&2
  exit 5
fi
echo "remote: scope-sub $INSTALLED is installed"

echo
echo "remote: running $BIN doctor"
"$BIN" doctor </dev/null
REMOTE_SH
}

step "plan"
say "  target      $REMOTE"
say "  remote dir  $DIR"
say "  tarball     $TARBALL (built from $REPO_DIR)"
say "  ssh options ${SSH_OPTS:-none}"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  MODE        dry run: nothing will be copied or installed"
fi

step "1/4 pack"
run "pnpm pack --pack-destination ."
if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$TARBALL" ]; then
  echo "deploy: expected $TARBALL after pnpm pack" >&2
  exit 1
fi

step "2/4 create the remote directory"
run "ssh $SSH_OPTS '$REMOTE' 'mkdir -p $DIR'"

step "3/4 copy the tarball"
run "scp $SSH_OPTS '$TARBALL' '$REMOTE:$DIR/'"

step "4/4 install remotely and run doctor"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '   $ ssh %s %s sh -s -- %s %s %s <<REMOTE_SH ... doctor\n' \
    "$SSH_OPTS" "$REMOTE" "$DIR" "$TARBALL" "$VERSION"
  say ""
  say "The remote script that would run:"
  remote_script | sed 's/^/   | /'
  say ""
  say "Dry run complete; nothing was changed on $REMOTE."
  exit 0
fi

# shellcheck disable=SC2086
remote_script | ssh $SSH_OPTS "$REMOTE" "sh -s -- '$DIR' '$TARBALL' '$VERSION'"

say ""
say "Deployed scope-sub $VERSION to $REMOTE:$DIR."
