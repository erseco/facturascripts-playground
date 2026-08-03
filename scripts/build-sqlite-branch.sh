#!/bin/sh
# Genera la rama feature/add-sqlite-support-stable en un clon del fork: importa
# la release oficial del canal stable como commit y le aplica el delta SQLite
# con merge a 3 bandas.
#
# El merge a 3 bandas es deliberado: `patch` falla ante la deriva de contexto
# entre master y una release antigua (por ejemplo el docblock que master anadio
# a Installer.php), y `patch --fuzz` no falla sino que acierta mal, colocando el
# hunk en otro sitio y dejando el build en verde con el codigo descolocado.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# Huella del propio generador: si cambia este script (la denylist, como se
# importa el zip, que entra en el arbol...) pero el delta y la release no
# cambian, el salto de mas abajo NO debe confundir "nada que hacer" con "el
# codigo que lo hizo esta desactualizado". $SCRIPT_DIR ya es absoluto (viene
# de un cd), asi que el hash no depende de si se invoco con ruta relativa o
# absoluta ni del directorio de trabajo actual.
GENERATOR_ID=$(git hash-object "$SCRIPT_DIR/$(basename -- "$0")")

WORK_DIR=${WORK_DIR:-"$REPO_DIR/.cache/sqlite-branch"}
REF_URL=${FS_REF:-"https://github.com/erseco/facturascripts.git"}
REF_BRANCH=${FS_REF_BRANCH:-"feature/add-sqlite-support"}
BASE_BRANCH=${FS_BASE_BRANCH:-"master"}

# La version sale del canal oficial stable, no de un argumento: la rama destino es
# unica y siempre representa "la ultima stable + SQLite".
FS_VERSION=${FS_VERSION:-$("$SCRIPT_DIR/detect-official-versions.sh" stable)}
case "$FS_VERSION" in
  *[!0-9.]*|'') echo "Version invalida: $FS_VERSION" >&2; exit 1 ;;
esac

TARGET_BRANCH=${FS_TARGET_BRANCH:-"feature/add-sqlite-support-stable"}
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
  git -C "$FORK_DIR" fetch origin "$TARGET_BRANCH" >&2 || true
fi

# Limpieza defensiva: si una ejecucion anterior aborto a media resolucion de
# un conflicto de cherry-pick, el clon queda con CHERRY_PICK_HEAD y rutas sin
# fusionar. Sin esto, la siguiente ejecucion moriria con un error crudo de
# git en el primer checkout. Es un no-op si el clon esta impoluto.
if [ -f "$FORK_DIR/.git/CHERRY_PICK_HEAD" ]; then
  echo "Limpiando cherry-pick sin terminar de una ejecucion anterior..." >&2
  git -C "$FORK_DIR" cherry-pick --abort >&2 || git -C "$FORK_DIR" reset --hard >&2
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

# Identificador determinista del CONTENIDO del delta: par ruta/blob de cada fichero,
# hasheado. No depende de marcas de tiempo ni del SHA del commit sintetizado, asi que
# dos ejecuciones con el mismo delta dan el mismo valor.
DELTA_ID=$(
  echo "$DELTA_FILES" | while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s %s\n' "$f" "$(git -C "$FORK_DIR" rev-parse "$REF_BRANCH:$f" 2>/dev/null || echo ausente)"
  done | git hash-object --stdin
)

# Si la rama destino ya se genero con esta misma version, este mismo delta y
# esta misma version del generador, no hay nada que hacer. Evita reescribir
# la rama cada noche sin motivo. El Generator-Id es imprescindible aqui: sin
# el, un cambio en la logica del script (denylist, importacion del zip...)
# con delta y release identicos se quedaria pegado en SIN-CAMBIOS para
# siempre, porque los otros dos trailers no se habrian movido.
if git -C "$FORK_DIR" rev-parse --verify --quiet "origin/$TARGET_BRANCH" >/dev/null; then
  TIP_MSG=$(git -C "$FORK_DIR" log -1 --format=%B "origin/$TARGET_BRANCH")
  TIP_RELEASE=$(printf '%s\n' "$TIP_MSG" | sed -n 's/^Release: //p' | tail -1)
  TIP_DELTA=$(printf '%s\n' "$TIP_MSG" | sed -n 's/^Delta-Id: //p' | tail -1)
  TIP_GENERATOR=$(printf '%s\n' "$TIP_MSG" | sed -n 's/^Generator-Id: //p' | tail -1)
  if [ "$TIP_RELEASE" = "$FS_VERSION" ] && [ "$TIP_DELTA" = "$DELTA_ID" ] \
      && [ "$TIP_GENERATOR" = "$GENERATOR_ID" ]; then
    echo "La rama $TARGET_BRANCH ya esta al dia (release $FS_VERSION, delta $DELTA_ID, generador $GENERATOR_ID)." >&2
    echo "SIN-CAMBIOS"
    exit 0
  fi
fi

# 3. Descargar y extraer la release oficial.
#    - Si el zip que ya hay en disco esta corrompido (descarga anterior
#      cortada a mitad, o cualquier otro motivo) se descarta y se vuelve a
#      descargar, en vez de dejar que reviente el unzip con un error opaco.
#    - La descarga en si se hace a un temporal que se mueve al destino solo
#      si curl termina bien, para que un corte de red no deje un zip a
#      medias que el siguiente intento de por bueno.
if [ -f "$ARCHIVE" ] && ! unzip -tqq "$ARCHIVE" >/dev/null 2>&1; then
  echo "Zip corrupto en $ARCHIVE; se descarta y se vuelve a descargar." >&2
  rm -f "$ARCHIVE"
fi
if [ ! -f "$ARCHIVE" ]; then
  ARCHIVE_TMP="$ARCHIVE.tmp"
  curl --fail --location --silent --show-error \
    "https://facturascripts.com/DownloadBuild/1/$FS_VERSION" --output "$ARCHIVE_TMP"
  mv "$ARCHIVE_TMP" "$ARCHIVE"
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

# El cherry-pick anade su propio commit encima del de la release; los trailers
# se escriben en ese commit final para que el historial de la rama los
# conserve y el Paso 3 pueda leerlos en la siguiente ejecucion.
git -C "$FORK_DIR" commit -q --amend -m "SQLite sobre la release oficial $FS_VERSION

Rama generada automaticamente por scripts/build-sqlite-branch.sh.
No commitear a mano: se reescribe con force-push cuando cambia la
release oficial del canal stable, cuando cambia el delta SQLite o
cuando cambia el propio generador.

Release: $FS_VERSION
Delta-Id: $DELTA_ID
Generator-Id: $GENERATOR_ID" >&2

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
