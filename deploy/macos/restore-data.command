#!/bin/zsh
set -euo pipefail

SOURCE_DIR="${0:A:h}"
ARCHIVE="${1:-$SOURCE_DIR/garment-canvas-data.tar.gz}"
DATA_PARENT="$HOME/Library/Application Support/GarmentCanvas"
DATA_DIR="$DATA_PARENT/data"
LABEL="${GARMENT_CANVAS_LABEL:-com.garmentcanvas.server}"
DOMAIN="gui/$(id -u)"

if [[ ! -f "$ARCHIVE" ]]; then
  print -u2 "Data archive not found: $ARCHIVE"
  print -u2 "Usage: restore-data.command /path/to/garment-canvas-data.tar.gz"
  exit 1
fi

if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  print -u2 "Stop Garment Canvas before restoring data."
  exit 1
fi

if ! /usr/bin/tar -tzf "$ARCHIVE" >/dev/null; then
  print -u2 "Data archive is corrupt or is not a gzip tar archive."
  exit 1
fi

if /usr/bin/tar -tzf "$ARCHIVE" | /usr/bin/awk '
  /^\// { bad=1 }
  /(^|\/)\.\.($|\/)/ { bad=1 }
  END { exit bad ? 0 : 1 }
'; then
  print -u2 "Unsafe path found in data archive; restore aborted."
  exit 1
fi

/bin/mkdir -p "$DATA_PARENT"
/bin/chmod 700 "$DATA_PARENT"
if [[ -d "$DATA_DIR" ]] && [[ -n "$(/bin/ls -A "$DATA_DIR" 2>/dev/null)" ]]; then
  BACKUP="$DATA_PARENT/data-before-restore-$(date +%Y%m%d-%H%M%S)"
  /bin/mv "$DATA_DIR" "$BACKUP"
  print "Existing data moved to: $BACKUP"
fi
/bin/mkdir -p "$DATA_DIR"
/usr/bin/tar -xzf "$ARCHIVE" -C "$DATA_DIR"
/bin/chmod 700 "$DATA_DIR"
print "Data restored to: $DATA_DIR"
