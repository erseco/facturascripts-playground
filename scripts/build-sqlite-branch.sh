#!/bin/sh
# Genera la rama sqlite/<version> en un clon del fork: importa la release
# oficial como commit y le aplica el delta SQLite con merge a 3 bandas.
#
# El merge a 3 bandas es deliberado: `patch` falla ante la deriva de contexto
# entre master y una release antigua (por ejemplo el docblock que master anadio
# a Installer.php), y `patch --fuzz` no falla sino que acierta mal, colocando el
# hunk en otro sitio y dejando el build en verde con el codigo descolocado.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WORK_DIR=${WORK_DIR:-"$REPO_DIR/.cache/sqlite-branch"}
REF_URL=${FS_REF:-"https://github.com/erseco/facturascripts.git"}
REF_BRANCH=${FS_REF_BRANCH:-"feature/add-sqlite-support"}
BASE_BRANCH=${FS_BASE_BRANCH:-"master"}

if [ -z "${FS_VERSION:-}" ]; then
  echo "FS_VERSION es obligatorio (por ejemplo FS_VERSION=2026.41)" >&2
  exit 1
fi
case "$FS_VERSION" in
  *[!0-9.]*|'') echo "Version invalida: $FS_VERSION" >&2; exit 1 ;;
esac

TARGET_BRANCH="sqlite/$FS_VERSION"
FORK_DIR="$WORK_DIR/fork"
RELEASE_DIR="$WORK_DIR/release-$FS_VERSION"
ARCHIVE="$WORK_DIR/CORE-$FS_VERSION.zip"

mkdir -p "$WORK_DIR"

# 1. Clon del fork. Hace falta historia real (no --depth 1): el merge a 3 bandas
#    necesita la base de fusion entre master y la rama de trabajo.
if [ ! -d "$FORK_DIR/.git" ]; then
  git clone "$REF_URL" "$FORK_DIR" >&2
else
  git -C "$FORK_DIR" fetch origin "$BASE_BRANCH" "$REF_BRANCH" >&2
fi
git -C "$FORK_DIR" checkout -q -B "$REF_BRANCH" "origin/$REF_BRANCH" >&2

MERGE_BASE=$(git -C "$FORK_DIR" merge-base "origin/$BASE_BRANCH" "$REF_BRANCH")

# 2. Delta curado: todo lo que la rama toca bajo Core/, menos la denylist.
#    Es el resultado de una regla, no un inventario que mantener: un fichero
#    nuevo bajo Core/ entra solo.
DELTA_FILES=$(git -C "$FORK_DIR" diff --name-only "$MERGE_BASE" "$REF_BRANCH" -- 'Core/' \
  | grep -v '^Core/Template/ModelClass.php$' \
  | grep -v '^Core/Controller/EditEjercicio.php$' || true)

if [ -z "$DELTA_FILES" ]; then
  echo "El delta SQLite salio vacio; algo va mal en la deteccion." >&2
  exit 1
fi

echo "Delta SQLite ($(echo "$DELTA_FILES" | wc -l | tr -d ' ') ficheros):" >&2
echo "$DELTA_FILES" | sed 's/^/    /' >&2

# 3. Descargar y extraer la release oficial.
if [ ! -f "$ARCHIVE" ]; then
  curl --fail --location --silent --show-error \
    "https://facturascripts.com/DownloadBuild/1/$FS_VERSION" --output "$ARCHIVE"
fi
if [ ! -f "$RELEASE_DIR/facturascripts/Core/Kernel.php" ]; then
  rm -rf "$RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  unzip -q "$ARCHIVE" -d "$RELEASE_DIR"
fi

# 4. Commit D: el delta curado sobre la base de fusion. Es el commit que se
#    cherry-pickea; su padre (MERGE_BASE) es la base del merge a 3 bandas.
git -C "$FORK_DIR" checkout -q -B "sqlite-delta-tmp" "$MERGE_BASE" >&2
echo "$DELTA_FILES" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$FORK_DIR/$(dirname "$f")"
  if git -C "$FORK_DIR" cat-file -e "$REF_BRANCH:$f" 2>/dev/null; then
    git -C "$FORK_DIR" show "$REF_BRANCH:$f" > "$FORK_DIR/$f"
  else
    rm -f "$FORK_DIR/$f"
  fi
done
git -C "$FORK_DIR" add -A >&2
git -C "$FORK_DIR" commit -q -m "Delta SQLite para $FS_VERSION" >&2
DELTA_COMMIT=$(git -C "$FORK_DIR" rev-parse HEAD)

# 5. Commit R: la release oficial importada tal cual. Se conservan vendor/ y
#    node_modules/ a proposito: el zip no trae composer.json ni package.json,
#    asi que sin ellos el bundle se quedaria sin dependencias.
git -C "$FORK_DIR" checkout -q -B "$TARGET_BRANCH" "$MERGE_BASE" >&2
find "$FORK_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -R "$RELEASE_DIR/facturascripts/." "$FORK_DIR/"
git -C "$FORK_DIR" add -A >&2
git -C "$FORK_DIR" commit -q -m "Importa la release oficial $FS_VERSION" >&2

# 6. Merge a 3 bandas. Un conflicto aqui aborta el script: significa que
#    upstream ha tocado la zona del delta y hay que resolverlo a mano.
if ! git -C "$FORK_DIR" cherry-pick "$DELTA_COMMIT" >&2; then
  echo >&2
  echo "CONFLICTO al aplicar el delta SQLite sobre $FS_VERSION." >&2
  echo "Resuelvelo en $FORK_DIR y termina con 'git cherry-pick --continue'." >&2
  exit 1
fi

# 7. Verificacion: los mismos controles que hacia el parcheo, mas php -l.
cd "$FORK_DIR"
grep -Fq 'use FacturaScripts\Core\Base\DataBase\SqliteEngine;' Core/Base/DataBase.php
grep -Fq "case 'sqlite':" Core/Base/DataBase.php
php -l Core/Base/DataBase/SqliteEngine.php >&2
php -l Core/Base/DataBase/SqliteQueries.php >&2
php -l Core/Base/DataBase.php >&2
php -l Core/Controller/Installer.php >&2

git -C "$FORK_DIR" branch -q -D "sqlite-delta-tmp" 2>/dev/null || true

echo "Rama $TARGET_BRANCH lista en $FORK_DIR" >&2
git -C "$FORK_DIR" rev-parse HEAD
