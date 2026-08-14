#!/bin/zsh
set -euo pipefail

SOURCE_DIR="${0:A:h}"
APP_ROOT="${GARMENT_CANVAS_HOME:-$HOME/Applications/GarmentCanvas}"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
SUPPORT_DIR="$HOME/Library/Application Support/GarmentCanvas"
DATA_DIR="$SUPPORT_DIR/data"
CONFIG_DIR="$SUPPORT_DIR/config"
ENV_FILE="$CONFIG_DIR/service.env"
LOG_DIR="$HOME/Library/Logs/GarmentCanvas"
PLIST_DIR="$HOME/Library/LaunchAgents"
LABEL="${GARMENT_CANVAS_LABEL:-com.garmentcanvas.server}"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if (( EUID == 0 )); then
  print -u2 "Do not run this LaunchAgent installer with sudo."
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This package is for macOS."
  exit 1
fi

if [[ ! -f "$SOURCE_DIR/app/dist/index.html" ]] ||
   [[ ! -f "$SOURCE_DIR/app/dist-server/index.js" ]] ||
   [[ ! -f "$SOURCE_DIR/app/package-lock.json" ]]; then
  print -u2 "Package is incomplete: dist, dist-server, or package-lock.json is missing."
  exit 1
fi

if [[ -f "$SOURCE_DIR/FILE-SHA256SUMS.txt" ]]; then
  print "Verifying package files..."
  if ! (
    cd "$SOURCE_DIR"
    /usr/bin/shasum -a 256 -c FILE-SHA256SUMS.txt >/dev/null
  ); then
    print -u2 "Package checksum verification failed. Re-copy or re-download the archive."
    exit 1
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  print -u2 "Node.js 20+ is required. Install it first from https://nodejs.org/"
  exit 1
fi

NODE_PATH="$(command -v node)"
if [[ "$NODE_PATH" != /* ]]; then
  print -u2 "Node.js executable must resolve to an absolute path; found: $NODE_PATH"
  exit 1
fi
NODE_MAJOR="$("$NODE_PATH" -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  print -u2 "Node.js 20+ is required; found $("$NODE_PATH" -v)."
  exit 1
fi

/bin/mkdir -p "$RELEASES_DIR" "$APP_ROOT/bin" "$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR" "$PLIST_DIR"
/bin/chmod 700 "$APP_ROOT" "$RELEASES_DIR" "$SUPPORT_DIR" "$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR"

RELEASE_ID="$(/bin/cat "$SOURCE_DIR/RELEASE-ID" 2>/dev/null || true)"
if [[ -z "$RELEASE_ID" ]]; then
  print -u2 "Invalid or missing RELEASE-ID."
  exit 1
fi
if ! print -r -- "$RELEASE_ID" | /usr/bin/grep -Eq '^[A-Za-z0-9._-]+$'; then
  print -u2 "Invalid or missing RELEASE-ID."
  exit 1
fi

RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
if [[ -e "$RELEASE_DIR" ]]; then
  RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID-reinstall-$(date +%Y%m%d-%H%M%S)"
fi
if [[ -e "$CURRENT_LINK" ]] && [[ ! -L "$CURRENT_LINK" ]]; then
  print -u2 "Cannot switch releases: $CURRENT_LINK exists and is not a symbolic link."
  exit 1
fi
STAGE_DIR="$RELEASES_DIR/.install-$(date +%s)-$$"
PLIST_TMP=""
cleanup_stage() {
  [[ -d "$STAGE_DIR" ]] && /bin/rm -rf "$STAGE_DIR"
  [[ -n "$PLIST_TMP" ]] && [[ -f "$PLIST_TMP" ]] && /bin/rm -f "$PLIST_TMP"
}
trap cleanup_stage EXIT INT TERM

/usr/bin/ditto "$SOURCE_DIR/app" "$STAGE_DIR"

# The online package installs production dependencies on the target Mac. The
# architecture-specific offline package already contains them and skips this step.
if [[ ! -f "$STAGE_DIR/node_modules/express/package.json" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    print -u2 "npm is required to install production dependencies."
    exit 1
  fi
  print "Installing production dependencies..."
  (
    cd "$STAGE_DIR"
    npm ci --omit=dev --no-audit --no-fund
  )
fi

(
  cd "$STAGE_DIR"
  "$NODE_PATH" -e "import('express').then(() => process.exit(0)).catch(() => process.exit(1))"
  "$NODE_PATH" -e "import('better-sqlite3').then(m => { const db = new m.default(':memory:'); db.close(); }).catch(() => process.exit(1))"
)

/bin/mv "$STAGE_DIR" "$RELEASE_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  /bin/cp "$SOURCE_DIR/config/.env.example" "$ENV_FILE"
  /bin/chmod 600 "$ENV_FILE"
  print
  print "Created $ENV_FILE"
  print "Edit it before starting the service:"
  print "  open -e '$ENV_FILE'"
fi

# Keep mutable configuration outside release directories. Each release receives
# only a symlink, so secrets never enter the application package.
ENV_FILE_PATH="$ENV_FILE" DATA_DIR_VALUE="$DATA_DIR" "$NODE_PATH" --input-type=module <<'NODE'
import fs from "node:fs";
const envPath = process.env.ENV_FILE_PATH;
const dataDir = process.env.DATA_DIR_VALUE;
let content = fs.readFileSync(envPath, "utf8");
const line = `DATA_DIR=${JSON.stringify(dataDir)}`;
if (/^DATA_DIR=.*$/m.test(content)) content = content.replace(/^DATA_DIR=.*$/m, line);
else content = `${content.replace(/\s*$/, "")}\n${line}\n`;
fs.writeFileSync(envPath, content, { mode: 0o600 });
NODE
/bin/chmod 600 "$ENV_FILE"
/bin/ln -s "$ENV_FILE" "$RELEASE_DIR/.env"

PLIST_TMP="$PLIST_PATH.tmp.$$"
/usr/bin/plutil -create xml1 "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :Label string $LABEL" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $NODE_PATH" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string $CURRENT_LINK/dist-server/index.js" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :WorkingDirectory string $CURRENT_LINK" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:NODE_ENV string production" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :ProcessType string Standard" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :Umask integer 63" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :ExitTimeOut integer 30" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $LOG_DIR/server.log" "$PLIST_TMP"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $LOG_DIR/server-error.log" "$PLIST_TMP"
/usr/bin/plutil -convert xml1 "$PLIST_TMP"
/usr/bin/plutil -lint "$PLIST_TMP" >/dev/null
/bin/chmod 644 "$PLIST_TMP"

# Stop the old release only after the new release and LaunchAgent have passed
# local validation, minimizing upgrade downtime and preserving rollback safety.
if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  /bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi
/bin/mv -f "$PLIST_TMP" "$PLIST_PATH"
PLIST_TMP=""

NEXT_LINK="$APP_ROOT/.current-$$"
/bin/ln -s "$RELEASE_DIR" "$NEXT_LINK"
/bin/mv -h -f "$NEXT_LINK" "$CURRENT_LINK"

/usr/bin/ditto "$SOURCE_DIR/app/bin" "$APP_ROOT/bin"
/bin/chmod 755 "$APP_ROOT/bin/garment-canvas-start" "$APP_ROOT/bin/garment-canvas-stop" "$APP_ROOT/bin/garment-canvas-status"
trap - EXIT INT TERM

print
print "Garment Canvas release:      $RELEASE_DIR"
print "Active release:              $CURRENT_LINK"
print "Persistent data directory:    $DATA_DIR"
print "Private configuration:        $ENV_FILE"
print "LaunchAgent:                 $PLIST_PATH"
print
print "After editing the configuration, start it with:"
print "  '$SOURCE_DIR/start.command'"
