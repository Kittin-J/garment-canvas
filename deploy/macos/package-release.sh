#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h:h}"
OUTPUT_DIR="$PROJECT_ROOT/releases"
INCLUDE_DATA=false

if [[ "${1:-}" == "--include-data" ]]; then
  INCLUDE_DATA=true
elif [[ -n "${1:-}" ]]; then
  print -u2 "Usage: $0 [--include-data]"
  exit 2
fi

cd "$PROJECT_ROOT"
if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "Mac release packaging must run on macOS."
  exit 1
fi
VERSION="$(node -p 'require("./package.json").version')"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCH="$(uname -m)"
RELEASE_ID="v$VERSION-$STAMP"
ONLINE_NAME="garment-canvas-$RELEASE_ID-universal-online"
OFFLINE_NAME="garment-canvas-$RELEASE_ID-darwin-$ARCH-offline"

/bin/mkdir -p "$OUTPUT_DIR"
TMP_ROOT="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/garment-canvas-release.XXXXXX")"
cleanup() {
  [[ -d "$TMP_ROOT" ]] && /bin/rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

print "Running release checks..."
npm run check
npm run build

populate_package() {
  local package_root="$1"
  local package_type="$2"

  /bin/mkdir -p "$package_root/app/bin" "$package_root/config"
  /usr/bin/ditto "$PROJECT_ROOT/dist" "$package_root/app/dist"
  /usr/bin/ditto "$PROJECT_ROOT/dist-server" "$package_root/app/dist-server"
  /bin/cp "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/package-lock.json" "$package_root/app/"
  /bin/cp "$SCRIPT_DIR/bin/garment-canvas-start" "$SCRIPT_DIR/bin/garment-canvas-stop" \
    "$SCRIPT_DIR/bin/garment-canvas-status" "$package_root/app/bin/"
  /bin/cp "$SCRIPT_DIR/install.command" "$SCRIPT_DIR/start.command" "$SCRIPT_DIR/stop.command" \
    "$SCRIPT_DIR/status.command" "$SCRIPT_DIR/uninstall.command" "$SCRIPT_DIR/restore-data.command" \
    "$SCRIPT_DIR/README-MACMINI.md" "$package_root/"
  /bin/cp "$PROJECT_ROOT/.env.example" "$package_root/config/.env.example"
  print -r -- "$RELEASE_ID" > "$package_root/RELEASE-ID"
  print -r -- "$package_type" > "$package_root/PACKAGE-TYPE"
  /bin/chmod 755 "$package_root"/*.command "$package_root/app/bin/"*
}

write_internal_checksums() {
  local package_root="$1"
  (
    cd "$package_root"
    /usr/bin/find . -type f ! -name FILE-SHA256SUMS.txt -print0 |
      /usr/bin/sort -z |
      /usr/bin/xargs -0 /usr/bin/shasum -a 256 > FILE-SHA256SUMS.txt
  )
}

ONLINE_ROOT="$TMP_ROOT/$ONLINE_NAME"
populate_package "$ONLINE_ROOT" "universal-online"
write_internal_checksums "$ONLINE_ROOT"

OFFLINE_ROOT="$TMP_ROOT/$OFFLINE_NAME"
/usr/bin/ditto "$ONLINE_ROOT" "$OFFLINE_ROOT"
print -r -- "darwin-$ARCH-offline" > "$OFFLINE_ROOT/PACKAGE-TYPE"
print "Installing production dependencies for the offline package..."
(
  cd "$OFFLINE_ROOT/app"
  npm ci --omit=dev --no-audit --no-fund
)
if ! docker image inspect postgres:17-alpine >/dev/null 2>&1; then
  print "Downloading PostgreSQL for the offline package..."
  docker pull postgres:17-alpine >/dev/null
fi
print "Bundling PostgreSQL for the offline package..."
docker save -o "$OFFLINE_ROOT/postgres-17-alpine.tar" postgres:17-alpine
write_internal_checksums "$OFFLINE_ROOT"

ONLINE_ARCHIVE="$OUTPUT_DIR/$ONLINE_NAME.tar.gz"
OFFLINE_ARCHIVE="$OUTPUT_DIR/$OFFLINE_NAME.tar.gz"
COPYFILE_DISABLE=1 /usr/bin/tar -czf "$ONLINE_ARCHIVE" -C "$TMP_ROOT" "$ONLINE_NAME"
COPYFILE_DISABLE=1 /usr/bin/tar -czf "$OFFLINE_ARCHIVE" -C "$TMP_ROOT" "$OFFLINE_NAME"

ARTIFACTS=("$ONLINE_ARCHIVE" "$OFFLINE_ARCHIVE")
if [[ "$INCLUDE_DATA" == true ]]; then
  DATA_ARCHIVE="$OUTPUT_DIR/garment-canvas-data-$STAMP.tar.gz"
  DATA_MANIFEST="$OUTPUT_DIR/garment-canvas-data-$STAMP.manifest.txt"
  print "Creating the separate data migration archive..."
  COPYFILE_DISABLE=1 /usr/bin/tar -czf "$DATA_ARCHIVE" -C "$PROJECT_ROOT/data" .
  {
    print "created_at=$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
    print "source=data/"
    print "file_count=$(/usr/bin/find "$PROJECT_ROOT/data" -type f | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
    print "file_bytes=$(/usr/bin/find "$PROJECT_ROOT/data" -type f -exec /usr/bin/stat -f '%z' {} + | /usr/bin/awk '{sum += $1} END {print sum + 0}')"
    print "allocated_bytes=$(/usr/bin/du -sk "$PROJECT_ROOT/data" | /usr/bin/awk '{print $1 * 1024}')"
  } > "$DATA_MANIFEST"
  ARTIFACTS+=("$DATA_ARCHIVE" "$DATA_MANIFEST")
fi

CHECKSUM_FILE="$OUTPUT_DIR/SHA256SUMS-$STAMP.txt"
(
  cd "$OUTPUT_DIR"
  artifact_names=()
  for artifact in "${ARTIFACTS[@]}"; do
    artifact_names+=("${artifact:t}")
  done
  /usr/bin/shasum -a 256 "${artifact_names[@]}" > "$CHECKSUM_FILE"
)

print
print "Release artifacts:"
for artifact in "${ARTIFACTS[@]}" "$CHECKSUM_FILE"; do
  /bin/ls -lh "$artifact"
done
