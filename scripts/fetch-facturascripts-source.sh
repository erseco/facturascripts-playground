#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CACHE_DIR=${CACHE_DIR:-"$REPO_DIR/.cache/facturascripts-source"}
REF_URL=${FS_REF:-"https://github.com/erseco/facturascripts.git"}
REF_BRANCH=${FS_REF_BRANCH:-"feature/add-sqlite-support"}
CLONE_DIR="$CACHE_DIR/repository"
mkdir -p "$CACHE_DIR"

if [ -n "${FS_VERSION:-}" ]; then
  case "$FS_VERSION" in
    *[!0-9.]*|'')
      echo "Invalid FacturaScripts version: $FS_VERSION" >&2
      exit 1
      ;;
  esac

  ARCHIVE="$CACHE_DIR/CORE-$FS_VERSION.zip"
  VERSION_DIR="$CACHE_DIR/version-$FS_VERSION"
  if [ ! -f "$ARCHIVE" ]; then
    curl --fail --location --silent --show-error \
      "https://facturascripts.com/DownloadBuild/1/$FS_VERSION" \
      --output "$ARCHIVE"
  fi
  if [ ! -f "$VERSION_DIR/Core/Kernel.php" ]; then
    rm -rf "$VERSION_DIR" "$VERSION_DIR.tmp"
    mkdir -p "$VERSION_DIR.tmp"
    unzip -q "$ARCHIVE" -d "$VERSION_DIR.tmp"
    mv "$VERSION_DIR.tmp/facturascripts" "$VERSION_DIR"
    rm -rf "$VERSION_DIR.tmp"
  fi

  printf '%s\n' "$VERSION_DIR"
  exit 0
fi

if [ ! -d "$CLONE_DIR/.git" ]; then
  git clone --depth 1 --branch "$REF_BRANCH" "$REF_URL" "$CLONE_DIR" >&2
else
  git -C "$CLONE_DIR" fetch --depth 1 origin "$REF_BRANCH" >&2
  git -C "$CLONE_DIR" checkout -B "$REF_BRANCH" FETCH_HEAD >&2
fi

printf '%s\n' "$CLONE_DIR"
