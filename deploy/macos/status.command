#!/bin/zsh
set -euo pipefail
APP_ROOT="${GARMENT_CANVAS_HOME:-$HOME/Applications/GarmentCanvas}"
"$APP_ROOT/bin/garment-canvas-status"
