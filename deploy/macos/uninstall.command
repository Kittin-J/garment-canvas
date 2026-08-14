#!/bin/zsh
set -euo pipefail

APP_ROOT="${GARMENT_CANVAS_HOME:-$HOME/Applications/GarmentCanvas}"
LABEL="${GARMENT_CANVAS_LABEL:-com.garmentcanvas.server}"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
POSTGRES_CONTAINER="${GARMENT_CANVAS_POSTGRES_CONTAINER:-garment-canvas-postgres}"
POSTGRES_VOLUME="${GARMENT_CANVAS_POSTGRES_VOLUME:-garment-canvas-postgres-data}"

if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  /bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi

if command -v docker >/dev/null 2>&1 && docker container inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1; then
  docker rm -f "$POSTGRES_CONTAINER" >/dev/null
fi

/bin/mkdir -p "$HOME/.Trash"
STAMP="$(date +%Y%m%d-%H%M%S)"
[[ -f "$PLIST_PATH" ]] && /bin/mv "$PLIST_PATH" "$HOME/.Trash/$LABEL.plist-$STAMP"
[[ -d "$APP_ROOT" ]] && /bin/mv "$APP_ROOT" "$HOME/.Trash/GarmentCanvas-app-$STAMP"

print "Application and LaunchAgent moved to Trash."
print "Persistent data was kept at: $HOME/Library/Application Support/GarmentCanvas/data"
print "PostgreSQL volume was kept: $POSTGRES_VOLUME"
