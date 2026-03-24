#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WORK_DIR=${WORK_DIR:-"$REPO_DIR/.cache/build-facturascripts"}
DIST_DIR=${DIST_DIR:-"$REPO_DIR/assets/facturascripts"}
MANIFEST_DIR=${MANIFEST_DIR:-"$REPO_DIR/assets/manifests"}
SOURCE_DIR=$("$SCRIPT_DIR/fetch-facturascripts-source.sh")
STAGE_DIR="$WORK_DIR/stage"
FS_STAGE="$STAGE_DIR/facturascripts"

rm -rf "$STAGE_DIR"
mkdir -p "$FS_STAGE" "$DIST_DIR" "$MANIFEST_DIR"

cp -R "$SOURCE_DIR"/. "$FS_STAGE"
rm -rf "$FS_STAGE/.git" "$FS_STAGE/.github" "$FS_STAGE/tests" "$FS_STAGE/Test"

perl -0pi -e "s/'curl',//g" "$FS_STAGE/Core/Controller/Installer.php"
perl -0pi -e "s/'fileinfo',//g" "$FS_STAGE/Core/Controller/Installer.php"
perl -0pi -e "s/'bcmath',//g" "$FS_STAGE/Core/Controller/Installer.php"
perl -pi -e 's/public function updateActivity\(string \$ipAddress, string \$browser/public function updateActivity(string \$ipAddress, ?string \$browser/' "$FS_STAGE/Core/Model/User.php"
perl -pi -e "s/\\\$browser = \\\$this->request->header\\('User-Agent'\\);/\\\$browser = \\\$this->request->header('User-Agent') ?? '';/" "$FS_STAGE/Core/Base/Controller.php"

if command -v composer >/dev/null 2>&1; then
  composer install --working-dir="$FS_STAGE" --no-dev --prefer-dist --no-progress --no-interaction --ignore-platform-reqs >&2
else
  echo "composer is required to materialize FacturaScripts vendor dependencies for the browser bundle." >&2
  return 1
fi

if [ -f "$FS_STAGE/package.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    npm install --prefix "$FS_STAGE" --production --no-audit --no-fund >&2
  else
    echo "Warning: npm not found. Frontend assets (CSS/JS) will be missing." >&2
  fi
fi

SOURCE_COMMIT=$(git -C "$SOURCE_DIR" rev-parse HEAD)
RELEASE=$(php -r 'preg_match("/private const VERSION = \x27([^\x27]+)\x27;/", file_get_contents("'"$FS_STAGE"'/Core/Kernel.php"), $m); echo $m[1] ?? "unknown";')
SAFE_RELEASE=$(printf '%s' "$RELEASE" | sed 's/[^A-Za-z0-9._-]/_/g')
BUNDLE_FILE="facturascripts-core-${SAFE_RELEASE}.zip"
BUNDLE_PATH="$DIST_DIR/$BUNDLE_FILE"
MANIFEST_PATH="$MANIFEST_DIR/latest.json"
FILE_COUNT=$(find "$FS_STAGE" -type f | wc -l | tr -d ' ')

echo "Creating ZIP bundle..." >&2
(cd "$FS_STAGE" && zip -qr "$BUNDLE_PATH" .)
echo "Bundle created: $BUNDLE_PATH ($FILE_COUNT files)" >&2

node "$SCRIPT_DIR/generate-manifest.mjs" \
  --channel browser \
  --manifest "$MANIFEST_PATH" \
  --release "$RELEASE" \
  --sourceRepository "${FS_REF:-https://github.com/erseco/facturascripts.git}" \
  --sourceBranch "${FS_REF_BRANCH:-feature/add-sqlite-support}" \
  --sourceCommit "$SOURCE_COMMIT" \
  --bundle "$BUNDLE_PATH" \
  --fileCount "$FILE_COUNT"

echo "Bundle written to $BUNDLE_PATH" >&2
echo "Manifest written to $MANIFEST_PATH" >&2
