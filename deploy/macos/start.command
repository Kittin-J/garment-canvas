#!/bin/zsh
set -euo pipefail

APP_ROOT="${GARMENT_CANVAS_HOME:-$HOME/Applications/GarmentCanvas}"
exec "$APP_ROOT/bin/garment-canvas-start"
