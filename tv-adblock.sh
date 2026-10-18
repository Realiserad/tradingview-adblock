#!/usr/bin/env bash
# Inject (or remove) an ad/tracker blocker in the TradingView desktop app.
#
#   sudo ./tv-adblock.sh install     patch /opt/TradingView/resources/app.asar
#   sudo ./tv-adblock.sh revert      restore the pristine asar from backup
#   ./tv-adblock.sh status           show whether the patch is applied
#
# Re-run "install" after every TradingView package update: apt replaces app.asar.
set -euo pipefail

RES=/opt/TradingView/resources
ASAR="$RES/app.asar"
# asar derives the "<name>.unpacked" sidecar directory from the archive's own
# filename, so the pristine copy has to keep the name app.asar and live in its
# own directory, with the sidecar symlinked back to the real one.
BACKUP_DIR="$RES/.adblock-orig"
BACKUP="$BACKUP_DIR/app.asar"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$HERE/payload.js"
MARKER="BEGIN tv-adblock"
ASARTOOL=(npx --yes @electron/asar)

die() { echo "error: $*" >&2; exit 1; }

# asar stores file contents uncompressed, so the marker is greppable in place.
is_patched() { grep -qa "$MARKER" "$1"; }

status() {
  [[ -f "$ASAR" ]] || die "$ASAR not found - is TradingView installed?"
  local ver; ver="$(dpkg-query -W -f='${Version}' tradingview 2>/dev/null || echo '?')"
  if is_patched "$ASAR"; then
    echo "patched     (TradingView $ver)"
    [[ -f "$BACKUP" ]] && echo "backup      $BACKUP" || echo "backup      MISSING"
    return 0
  fi
  echo "not patched (TradingView $ver)"
  return 1
}

install_patch() {
  [[ $EUID -eq 0 ]] || die "run with sudo"
  [[ -f "$PAYLOAD" ]] || die "payload.js not found next to this script"
  [[ -f "$ASAR" ]] || die "$ASAR not found"

  local work; work="$(mktemp -d)"; trap 'rm -rf "$work"' RETURN
  local src="$ASAR"

  # Keep one pristine copy. If a backup already exists, always patch from it so
  # the payload is never injected twice and app updates are picked up cleanly.
  mkdir -p "$BACKUP_DIR"
  ln -sfn "$RES/app.asar.unpacked" "$BACKUP_DIR/app.asar.unpacked"

  if [[ -f "$BACKUP" ]]; then
    # An unpatched asar that differs from the backup means apt replaced it.
    if ! is_patched "$ASAR" && ! cmp -s "$ASAR" "$BACKUP"; then
      echo "new TradingView version detected, refreshing backup"
      cp -a "$ASAR" "$BACKUP"
    fi
  else
    echo "backing up pristine asar -> $BACKUP"
    cp -a "$ASAR" "$BACKUP"
  fi
  src="$BACKUP"

  echo "extracting $src"
  "${ASARTOOL[@]}" extract "$src" "$work/app" >/dev/null

  grep -q "$MARKER" "$work/app/index.js" \
    && die "backup is already patched - delete $BACKUP and reinstall the tradingview package"

  echo "injecting payload"
  cat "$PAYLOAD" "$work/app/index.js" > "$work/index.js.new"
  mv "$work/index.js.new" "$work/app/index.js"

  echo "repacking"
  "${ASARTOOL[@]}" pack "$work/app" "$work/app.asar" --unpack "*.node" >/dev/null

  # The three native .node modules must stay outside the archive: dlopen cannot
  # load from inside an asar. Verify before touching the installed file.
  local want got
  want="$(cd "$RES/app.asar.unpacked" && find . -name '*.node' | sort)"
  got="$(cd "$work/app.asar.unpacked" 2>/dev/null && find . -name '*.node' | sort || true)"
  [[ "$want" == "$got" ]] || die "unpacked .node set differs; refusing to install
expected:
$want
got:
$got"

  install -o root -g root -m 644 "$work/app.asar" "$ASAR"
  echo "installed. restart TradingView."
}

revert() {
  [[ $EUID -eq 0 ]] || die "run with sudo"
  [[ -f "$BACKUP" ]] || die "no backup at $BACKUP"
  install -o root -g root -m 644 "$BACKUP" "$ASAR"
  echo "reverted to pristine asar. restart TradingView."
}

case "${1:-status}" in
  install) install_patch ;;
  revert)  revert ;;
  status)  status ;;
  *) die "usage: $0 {install|revert|status}" ;;
esac
