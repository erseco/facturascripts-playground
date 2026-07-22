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

# Official builds do not include the pending SQLite support required by the
# browser runtime. Apply the immutable runtime portion of the fork's SQLite
# commit. ModelClass is intentionally excluded: supported releases already
# contain their own length validation and that hunk differs between channels.
if [ -n "${FS_VERSION:-}" ]; then
  curl --fail --location --silent --show-error \
    "https://github.com/erseco/facturascripts/commit/14f07e6f2d7ebdace161e5383122011a73d6378c.diff" \
    --output "$WORK_DIR/sqlite-support.diff"
  (
    cd "$FS_STAGE"
    git apply --check --exclude='Core/Template/ModelClass.php' \
      --include='Core/**' "$WORK_DIR/sqlite-support.diff"
    git apply --exclude='Core/Template/ModelClass.php' \
      --include='Core/**' "$WORK_DIR/sqlite-support.diff"
  )
fi

perl -0pi -e "s/'curl',//g" "$FS_STAGE/Core/Controller/Installer.php"
perl -0pi -e "s/'fileinfo',//g" "$FS_STAGE/Core/Controller/Installer.php"
perl -0pi -e "s/'bcmath',//g" "$FS_STAGE/Core/Controller/Installer.php"
perl -pi -e 's/public function updateActivity\(string \$ipAddress, string \$browser/public function updateActivity(string \$ipAddress, ?string \$browser/' "$FS_STAGE/Core/Model/User.php"
perl -pi -e "s/\\\$browser = \\\$this->request->header\\('User-Agent'\\);/\\\$browser = \\\$this->request->header('User-Agent') ?? '';/" "$FS_STAGE/Core/Base/Controller.php"

if [ -f "$FS_STAGE/composer.json" ]; then
  if command -v composer >/dev/null 2>&1; then
    composer install --working-dir="$FS_STAGE" --no-dev --prefer-dist --no-progress --no-interaction --ignore-platform-reqs >&2
  else
    echo "composer is required to materialize FacturaScripts vendor dependencies for the browser bundle." >&2
    exit 1
  fi
elif [ ! -f "$FS_STAGE/vendor/autoload.php" ]; then
  echo "The official build does not contain materialized Composer dependencies." >&2
  exit 1
fi

if [ -f "$FS_STAGE/package.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    npm install --prefix "$FS_STAGE" --production --no-audit --no-fund >&2
  else
    echo "Warning: npm not found. Frontend assets (CSS/JS) will be missing." >&2
  fi
fi

# Additional low-risk metadata and static-analysis config files that are never
# used by the in-browser runtime.
find "$FS_STAGE" \
  \( -name '.editorconfig' \
  -o -name 'psalm.xml' -o -name 'psalm.xml.dist' \
  -o -name 'phpstan.neon' -o -name 'phpstan.neon.dist' \
  -o -name '.phpcs.xml' -o -name '.phpcs.xml.dist' \
  -o -name 'phpcs.xml' -o -name 'phpcs.xml.dist' \) \
  -delete
find "$FS_STAGE" -path '*/.github/workflows/*' -delete

# node_modules is served to the browser at runtime (Kernel routes /node_modules/*
# to the Files controller and the layout templates load bootstrap/jquery/... from
# it), so the bundle must keep it. But node_modules/.bin holds POSIX symlinks to
# dev CLIs that are useless in the browser and that the files-only tar packer
# would drop silently anyway — remove them. This is a no-op for the current
# FacturaScripts frontend deps (none ship a bin) but guards CI machines whose
# transitive deps do.
rm -rf "$FS_STAGE/node_modules/.bin"

# The files-only tar packer (build-tar-zst-bundle.mjs) never emits directory
# entries — it rebuilds dirs from each file's parent path — so empty directories
# are bundle-neutral. composer/npm can legitimately leave some (or removing .bin
# above may empty a parent), so prune them (cascading, deepest-first) instead of
# failing the build.
find "$FS_STAGE" -depth -type d -empty -delete

# Tripwire against the real data-loss risk: the packer walks regular files only
# (isFile()) and never follows symlinks, so any symlink left in the stage vanishes
# from the bundle with no trace, and the file-count parity check (regular files on
# both sides) is blind to it. Fail loud instead.
SYMLINKS=$(find "$FS_STAGE" -type l)
if [ -n "$SYMLINKS" ]; then
  echo "ERROR: staged tree has symlinks the tar packer would silently drop:" >&2
  echo "$SYMLINKS" | sed 's/^/    /' >&2
  exit 1
fi

if [ -d "$SOURCE_DIR/.git" ]; then
  SOURCE_COMMIT=$(git -C "$SOURCE_DIR" rev-parse HEAD)
  SOURCE_REPOSITORY=${FS_REF:-https://github.com/erseco/facturascripts.git}
  SOURCE_BRANCH=${FS_REF_BRANCH:-feature/add-sqlite-support}
else
  SOURCE_COMMIT="official-$FS_VERSION"
  SOURCE_REPOSITORY="https://facturascripts.com/DownloadBuild/1/$FS_VERSION"
  SOURCE_BRANCH=$FS_VERSION
fi
RELEASE=$(php -r 'preg_match("/function version\(\).*?return\s+([\d.]+)/s", file_get_contents("'"$FS_STAGE"'/Core/Kernel.php"), $m); echo $m[1] ?? "unknown";')
SAFE_RELEASE=$(printf '%s' "$RELEASE" | sed 's/[^A-Za-z0-9._-]/_/g')
BUNDLE_FILE="facturascripts-core-${SAFE_RELEASE}.tar.zst"
BUNDLE_PATH="$DIST_DIR/$BUNDLE_FILE"
MANIFEST_PATH="$MANIFEST_DIR/${MANIFEST_FILE:-latest.json}"

# Pack the staged tree ($FS_STAGE holds the root-relative core) into a
# deterministic, zstd-compressed tar. The browser runtime extracts it by
# streaming zstd decode + incremental USTAR parsing (see
# lib/streaming-tar-extract.js), so no ZipArchive stage is needed at boot.
# The helper prints the tar entry (file) count, which is the exact count the
# streaming parser reports at boot — used for the manifest parity tripwire.
# Requires Node >= 22.15 for native node:zlib zstd.
echo "Creating tar.zst bundle..." >&2
FILE_COUNT=$(node "$SCRIPT_DIR/build-tar-zst-bundle.mjs" "$FS_STAGE" "$BUNDLE_PATH")
if [ ! -f "$BUNDLE_PATH" ]; then
  echo "ERROR: expected tar.zst bundle was not produced: $BUNDLE_PATH" >&2
  exit 1
fi
echo "Bundle created: $BUNDLE_PATH ($FILE_COUNT files)" >&2

node "$SCRIPT_DIR/generate-manifest.mjs" \
  --channel browser \
  --manifest "$MANIFEST_PATH" \
  --release "$RELEASE" \
  --sourceRepository "$SOURCE_REPOSITORY" \
  --sourceBranch "$SOURCE_BRANCH" \
  --sourceCommit "$SOURCE_COMMIT" \
  --bundle "$BUNDLE_PATH" \
  --fileCount "$FILE_COUNT"

# Update bundleVersion in playground.config.json so the SW cache-busts on each build.
BUILD_VERSION="${RELEASE}-build$(date +%Y%m%d%H%M)"
CONFIG_FILE="$REPO_DIR/playground.config.json"
if [ "${UPDATE_CONFIG:-true}" = "true" ] && [ -f "$CONFIG_FILE" ]; then
  sed -i.bak "s/\"bundleVersion\":.*$/\"bundleVersion\": \"$BUILD_VERSION\",/" "$CONFIG_FILE"
  rm -f "$CONFIG_FILE.bak"
  echo "Updated bundleVersion to $BUILD_VERSION" >&2
fi

echo "Bundle written to $BUNDLE_PATH" >&2
echo "Manifest written to $MANIFEST_PATH" >&2
