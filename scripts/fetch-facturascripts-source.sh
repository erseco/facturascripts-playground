#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CACHE_DIR=${CACHE_DIR:-"$REPO_DIR/.cache/facturascripts-source"}
REF_URL=${FS_REF:-"https://github.com/erseco/facturascripts.git"}
REF_BRANCH=${FS_REF_BRANCH:-"feature/add-sqlite-support"}
CLONE_DIR="$CACHE_DIR/repository"
mkdir -p "$CACHE_DIR"

# El canal elige la rama. Ambas existen siempre, asi que el build nunca falla por una
# rama que todavia no se ha generado.
if [ -n "${FS_CHANNEL:-}" ]; then
  case "$FS_CHANNEL" in
    stable) REF_BRANCH="feature/add-sqlite-support-stable" ;;
    dev)    REF_BRANCH="feature/add-sqlite-support" ;;
    *) echo "Canal invalido: $FS_CHANNEL (usa stable o dev)" >&2; exit 1 ;;
  esac
fi

if [ ! -d "$CLONE_DIR/.git" ]; then
  git clone --depth 1 --branch "$REF_BRANCH" "$REF_URL" "$CLONE_DIR" >&2
else
  git -C "$CLONE_DIR" fetch --depth 1 origin "$REF_BRANCH" >&2
  git -C "$CLONE_DIR" checkout -B "$REF_BRANCH" FETCH_HEAD >&2
fi

printf '%s\n' "$CLONE_DIR"
