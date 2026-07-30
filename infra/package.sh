#!/usr/bin/env bash
#
# Builds the frontend, assembles a deployable bundle and uploads it to S3.
#
# The bundle layout matches what the instance expects:
#   server/            Node server plus package.json and package-lock.json
#   web/dist/          Built static assets served by the server
#
# Node modules are deliberately not bundled; the instance runs `npm ci` so
# native dependencies are built for its own architecture.
#
# Usage: ./package.sh s3://my-bucket/ai-chat/app.tar.gz
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 s3://bucket/key.tar.gz" >&2
  exit 64
fi

DESTINATION="$1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "Building frontend..."
(cd "$ROOT/web" && npm ci && npm run build)

echo "Assembling bundle..."
mkdir -p "$STAGING/server" "$STAGING/web"
cp -R "$ROOT/server/src" "$STAGING/server/src"
cp "$ROOT/server/package.json" "$STAGING/server/"
# package-lock.json is required for `npm ci` on the instance.
cp "$ROOT/server/package-lock.json" "$STAGING/server/"
cp -R "$ROOT/web/dist" "$STAGING/web/dist"

ARCHIVE="$STAGING/app.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGING" server web

echo "Uploading to $DESTINATION..."
aws s3 cp "$ARCHIVE" "$DESTINATION"

echo "Done. Deploy or update the stack with ArtifactS3Uri=$DESTINATION"
echo "If the stack already exists, replace the instance to pick up the new bundle:"
echo "  aws cloudformation update-stack ... (or reboot and re-run user data)"
