# Ramas SQLite por version publicada - Plan de implementacion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el bundle del deploy salga de una rama `sqlite/<version>` generada automaticamente en el fork, en vez de parchear la release oficial con un commit fijado a mano.

**Architecture:** Un workflow programado en el playground genera, para cada version oficial soportada, una rama `sqlite/<version>` en `erseco/facturascripts` = release oficial importada como commit + delta SQLite aplicado con merge a 3 bandas. El build del playground deja de parchear: clona esa rama y punto.

**Tech Stack:** Shell POSIX (`sh`), git, GitHub Actions, Node 24 (solo para el empaquetado ya existente).

## Global Constraints

- El delta se define como `origin/master...feature/add-sqlite-support` (tres puntos, base de fusion) restringido a `Core/`, menos la denylist.
- Denylist inicial: `Core/Template/ModelClass.php` y `Core/Controller/EditEjercicio.php`.
- La aplicacion del delta es **merge a 3 bandas** (`git cherry-pick`). Nunca `patch`, nunca `--fuzz`.
- Conflicto = fallo del pipeline. No se publica nada a medio mezclar.
- El arbol importado del zip oficial **conserva `vendor/` y `node_modules/`**. El zip no trae `composer.json` ni `package.json`, asi que quitarlos dejaria el build sin dependencias.
- Repo del fork: `https://github.com/erseco/facturascripts.git`. Rama de trabajo: `feature/add-sqlite-support`.
- Estilo de la documentacion del repo: castellano sin tildes.

## Correccion al spec

El spec (`docs/superpowers/specs/2026-07-31-sqlite-version-branches-design.md`) dice, en "Workflow de generacion" paso 1 y en "Riesgos", que hay que descartar `vendor/` y `node_modules/` al importar el zip. **Es incorrecto** y se corrige en la Tarea 5: el zip oficial no incluye `composer.json`, `composer.lock` ni `package.json`, de modo que `build-facturascripts-bundle.sh` cae en la rama `elif [ ! -f "$FS_STAGE/vendor/autoload.php" ]` y aborta. Hay que conservarlos. Coste medido: 29 MB y 2155 ficheros por version, con deduplicacion de git entre versiones.

Segunda desviacion deliberada: el spec dice que un conflicto "abre una PR". Se simplifica a **fallar el workflow**, que es lo que se acordo en la conversacion de diseno ("daria un error el pipeline y yo lo arreglaria"). Abrir una PR con marcadores de conflicto es maquinaria extra sin valor: el arreglo es local de todos modos.

Tercera correccion, y esta invalida una promesa del spec. La seccion "Verificacion" dice que el CI puede correr la suite de tests con SQLite contra la rama `sqlite/<version>` antes de publicar, y lo presenta como la ganancia principal. **No es viable:** la release oficial no incluye `Test/` ni `phpunit.xml`, de modo que la rama generada no tiene suite que correr. Copiar `Test/` del fork tampoco sirve: los tests del fork prueban codigo de master que la release no contiene (`EditEjercicioTest` es el ejemplo exacto), asi que fallarian por construccion.

La verificacion real que si es factible, y que implementa este plan, tiene tres capas:

1. Los controles dentro de `build-sqlite-branch.sh`: los `grep` de que el enganche existe mas `php -l` sobre los ficheros tocados.
2. Un smoke test en el workflow: construir el bundle desde la rama recien generada y comprobar que contiene los ficheros SQLite. Es el consumidor real, asi que prueba lo que importa.
3. Los tests e2e de Playwright del playground, que arrancan el bundle en un navegador de verdad. Es la unica cobertura de integracion real y ya existe.

---

### Task 1: Script de generacion de la rama `sqlite/<version>`

**Files:**
- Create: `scripts/build-sqlite-branch.sh`
- Modify: `Makefile:5` (anadir target a `.PHONY` y el target nuevo)

**Interfaces:**
- Consumes: nada de tareas previas.
- Produces: `scripts/build-sqlite-branch.sh`, invocable como
  `FS_VERSION=<version> [FS_REF=<url>] [FS_REF_BRANCH=<rama>] [WORK_DIR=<dir>] scripts/build-sqlite-branch.sh`.
  Deja la rama `sqlite/$FS_VERSION` creada en el clon local `$WORK_DIR/fork` y **no** hace push.
  Imprime por stdout el SHA del commit resultante.

- [ ] **Step 1: Verificar que el script todavia no existe**

Run: `test ! -f scripts/build-sqlite-branch.sh && echo "no existe (correcto)"`
Expected: imprime `no existe (correcto)`

- [ ] **Step 2: Escribir el script**

Crear `scripts/build-sqlite-branch.sh`:

```sh
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
```

- [ ] **Step 3: Darle permiso de ejecucion**

Run: `chmod +x scripts/build-sqlite-branch.sh`

- [ ] **Step 4: Ejecutarlo de verdad contra la stable actual**

Run: `FS_VERSION=2026.41 sh scripts/build-sqlite-branch.sh`
Expected: lista los 7 ficheros del delta, no reporta conflicto, los `php -l` salen "No syntax errors detected", y la ultima linea es un SHA de 40 caracteres.

Si falla en el paso de cherry-pick, el delta necesita curacion adicional: mira que fichero conflictua y decide si es un arreglo adelantado (va a la denylist) o un conflicto real.

- [ ] **Step 5: Comprobar que el resultado es la release + SQLite, no master**

Run:
```bash
git -C .cache/sqlite-branch/fork show --stat HEAD | head -20
grep -c "countWrongLengthSubaccounts" .cache/sqlite-branch/fork/Core/Controller/EditEjercicio.php
```
Expected: el `show --stat` lista los 7 ficheros del delta; el `grep -c` devuelve `0`, confirmando que el arreglo adelantado se quedo fuera y que el arbol es el de la release.

- [ ] **Step 6: Anadir el target al Makefile**

En `Makefile:5`, cambiar la linea `.PHONY` para incluir `sqlite-branch`:

```make
.PHONY: help up deps prepare bundle serve test test-e2e lint format clean reset sqlite-branch
```

Y anadir el target despues del target `bundle`:

```make
sqlite-branch:
	@test -n "$(VERSION)" || { echo 'Uso: make sqlite-branch VERSION=2026.41'; exit 1; }
	FS_VERSION=$(VERSION) FS_REF=$(FS_REF) FS_REF_BRANCH=$(FS_REF_BRANCH) sh scripts/build-sqlite-branch.sh
```

- [ ] **Step 7: Verificar el target**

Run: `make sqlite-branch 2>&1 | head -3`
Expected: falla con `Uso: make sqlite-branch VERSION=2026.41` (comprueba la guarda del parametro).

- [ ] **Step 8: Commit**

```bash
git add scripts/build-sqlite-branch.sh Makefile
git commit -m "Genera ramas sqlite/<version> con merge a 3 bandas"
```

---

### Task 2: Workflow de generacion y publicacion

**Files:**
- Create: `scripts/detect-official-versions.sh`
- Create: `.github/workflows/sqlite-branches.yml`
- Modify: `.github/workflows/pages.yml:42-56` (usar el script compartido)

**Interfaces:**
- Consumes: `scripts/build-sqlite-branch.sh` de la Tarea 1 (variables `FS_VERSION`, `WORK_DIR`; deja la rama en `$WORK_DIR/fork`).
- Produces: ramas `sqlite/<version>` empujadas a `erseco/facturascripts`, y
  `scripts/detect-official-versions.sh <canal>`, que imprime por stdout la version publicada
  en `stable` o `beta` (por ejemplo `2026.41`) y sale con codigo distinto de cero si no la
  puede determinar.

**Ampliacion de alcance decidida fuera del plan original:** la deteccion de versiones se
extrae a un script compartido en vez de duplicar la funcion bash `channel_version()` en el
workflow nuevo. Eso obliga a tocar tambien `pages.yml`, que no estaba en el plan. La
duplicacion literal de un bloque de logica es un defecto que el revisor marcaria, y aqui se
evita de raiz.

**Decision de ubicacion:** el workflow vive en el repo del playground, no en el fork. Razones: (a) GitHub Actions solo dispara `schedule` desde la rama por defecto, asi que en el fork tendria que ir en `master`, que es justo la rama que se sincroniza con upstream y donde un fichero propio estorba con la PR #1908 abierta; (b) mantiene toda la automatizacion del playground en un sitio. El coste es necesitar un PAT.

- [ ] **Step 1: Crear el secreto (paso humano, diferido)**

El workflow necesita un fine-grained PAT con permiso `Contents: read and write` sobre
`erseco/facturascripts`, guardado en el playground como secreto `FORK_PUSH_TOKEN`:

```bash
gh secret set FORK_PUSH_TOKEN --repo erseco/facturascripts-playground
```

**Solo lo puede hacer una persona**, asi que este paso queda pendiente y no bloquea al resto
de la tarea: el fichero del workflow se escribe igual y queda listo para cuando el secreto
exista. Las ramas `sqlite/<version>` de hoy se publican a mano con SSH (Tarea 3, Step 0), que
es lo que se acordo. Hasta que el secreto exista, una ejecucion programada del workflow
fallara en el paso de publicar; es un fallo esperado y visible, no un error silencioso.

- [ ] **Step 2: Escribir el detector de versiones compartido**

Crear `scripts/detect-official-versions.sh`:

```sh
#!/bin/sh
# Imprime la version de FacturaScripts publicada en un canal oficial.
# Uso: scripts/detect-official-versions.sh stable|beta
#
# La version se lee de la cabecera Content-Disposition de la descarga, que
# viene como filename="CORE-2026.41.zip". Se usa sh POSIX a proposito, para
# que valga tanto en los workflows como en local.
set -eu

CHANNEL=${1:-}
case "$CHANNEL" in
  stable|beta) ;;
  *) echo "Uso: $0 stable|beta" >&2; exit 1 ;;
esac

HEADERS=$(curl --fail --silent --show-error --location --head \
  "https://facturascripts.com/DownloadBuild/1/$CHANNEL")

VERSION=$(printf '%s\n' "$HEADERS" \
  | sed -nE 's/.*filename="?CORE-([0-9]{4}(\.[0-9]+)?)\.zip"?.*/\1/ip' \
  | tail -1)

case "$VERSION" in
  ''|*[!0-9.]*)
    echo "No se pudo detectar la version del canal $CHANNEL" >&2
    exit 1
    ;;
esac

printf '%s' "$VERSION"
```

- [ ] **Step 3: Probar el detector contra los dos canales**

Run:
```bash
chmod +x scripts/detect-official-versions.sh
echo "stable=$(scripts/detect-official-versions.sh stable)"
echo "beta=$(scripts/detect-official-versions.sh beta)"
scripts/detect-official-versions.sh nosoyuncanal 2>&1 || echo "rechaza canal invalido (correcto)"
```
Expected: imprime `stable=` y `beta=` con versiones del tipo `2026.41` y `2026.5`, y la
tercera linea imprime `rechaza canal invalido (correcto)`.

- [ ] **Step 4: Sustituir la funcion duplicada en pages.yml**

En `.github/workflows/pages.yml`, borrar la definicion completa de `channel_version()`
(desde `channel_version() {` hasta su `}`, lineas 42-53) y sustituir las dos llamadas

```bash
          stable=$(channel_version stable)
          beta=$(channel_version beta)
```

por

```bash
          stable=$(scripts/detect-official-versions.sh stable)
          beta=$(scripts/detect-official-versions.sh beta)
```

El resto del step (`matrix`, `index`, `changed`, las salidas) no se toca.

- [ ] **Step 5: Verificar que pages.yml sigue siendo valido**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/pages.yml')); print('pages.yml valido')"`
Expected: imprime `pages.yml valido`.

Comprobar ademas que no queda rastro de la funcion:

Run: `grep -c "channel_version" .github/workflows/pages.yml || echo "0 coincidencias (correcto)"`
Expected: `0 coincidencias (correcto)`.

- [ ] **Step 6: Verificar que el workflow no existe**

Run: `test ! -f .github/workflows/sqlite-branches.yml && echo "no existe (correcto)"`
Expected: imprime `no existe (correcto)`

- [ ] **Step 7: Escribir el workflow**

Crear `.github/workflows/sqlite-branches.yml`:

```yaml
name: SQLite branches

on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:
    inputs:
      version:
        description: "Version concreta a generar (vacio = stable y beta)"
        required: false
        type: string

jobs:
  versions:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.detect.outputs.matrix }}
    steps:
      - uses: actions/checkout@v7

      - id: detect
        run: |
          set -euo pipefail

          if [[ -n "${{ inputs.version }}" ]]; then
            matrix=$(jq -nc --arg v "${{ inputs.version }}" '{version: [$v]}')
          else
            stable=$(scripts/detect-official-versions.sh stable)
            beta=$(scripts/detect-official-versions.sh beta)
            if [[ "$stable" == "$beta" ]]; then
              matrix=$(jq -nc --arg s "$stable" '{version: [$s]}')
            else
              matrix=$(jq -nc --arg s "$stable" --arg b "$beta" '{version: [$s, $b]}')
            fi
          fi
          echo "matrix=$matrix" >> "$GITHUB_OUTPUT"
          echo "Versiones a generar: $matrix"

  build:
    needs: versions
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: ${{ fromJson(needs.versions.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v7

      - uses: shivammathur/setup-php@v2
        with:
          php-version: "8.3"
          tools: composer

      - uses: actions/setup-node@v7
        with:
          # build-tar-zst-bundle.mjs necesita el zstd nativo de node:zlib.
          node-version: 24
          cache: npm

      - name: Comprobar si la rama ya esta al dia
        id: check
        env:
          FS_VERSION: ${{ matrix.version }}
        run: |
          set -euo pipefail
          if git ls-remote --exit-code --heads \
              https://github.com/erseco/facturascripts.git "sqlite/$FS_VERSION" >/dev/null 2>&1; then
            echo "existe=true" >> "$GITHUB_OUTPUT"
            echo "La rama sqlite/$FS_VERSION ya existe."
          else
            echo "existe=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Generar la rama
        if: steps.check.outputs.existe == 'false'
        env:
          FS_VERSION: ${{ matrix.version }}
          WORK_DIR: ${{ runner.temp }}/sqlite-branch
        run: sh scripts/build-sqlite-branch.sh

      - name: Smoke test - construir el bundle desde la rama
        if: steps.check.outputs.existe == 'false'
        env:
          VERSION: ${{ matrix.version }}
          MANIFEST_FILE: smoke-${{ matrix.version }}.json
          UPDATE_CONFIG: "false"
        run: |
          set -euo pipefail
          npm install
          # Se construye contra el clon local, que ya tiene la rama generada, y
          # por la ruta de git (FS_REF + FS_REF_BRANCH) en vez de por FS_VERSION.
          # Asi el smoke test no depende de la Tarea 3: funciona igual antes y
          # despues de que fetch-facturascripts-source.sh aprenda a resolver
          # sqlite/<version>.
          FS_REF="${{ runner.temp }}/sqlite-branch/fork" \
          FS_REF_BRANCH="sqlite/$VERSION" \
            npm run bundle
          test -f "assets/manifests/smoke-${VERSION}.json"
          tar --use-compress-program=unzstd -tf \
            assets/facturascripts/facturascripts-core-*.tar.zst \
            | grep -q 'Core/Base/DataBase/SqliteEngine.php'
          tar --use-compress-program=unzstd -tf \
            assets/facturascripts/facturascripts-core-*.tar.zst \
            | grep -q 'Core/Base/DataBase/SqliteQueries.php'
          echo "Smoke test correcto: el bundle lleva el soporte SQLite."

      - name: Publicar la rama
        if: steps.check.outputs.existe == 'false'
        env:
          FS_VERSION: ${{ matrix.version }}
          WORK_DIR: ${{ runner.temp }}/sqlite-branch
          TOKEN: ${{ secrets.FORK_PUSH_TOKEN }}
        run: |
          set -euo pipefail
          cd "$WORK_DIR/fork"
          git push "https://x-access-token:${TOKEN}@github.com/erseco/facturascripts.git" \
            "sqlite/$FS_VERSION"
          echo "Publicada sqlite/$FS_VERSION"
```

Nota sobre el `if` de "ya existe": la generacion es idempotente por version. Una release publicada no cambia, asi que regenerarla cada noche seria trabajo tirado. Cuando cambies el delta SQLite y quieras rehacer una rama, borrala (`git push --delete`) y el workflow la recrea, o usa `workflow_dispatch` con la version.

- [ ] **Step 8: Validar la sintaxis del workflow**

Run: `npx --yes yaml-lint .github/workflows/sqlite-branches.yml || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/sqlite-branches.yml')); print('YAML valido')"`
Expected: imprime `YAML valido` (o el lint pasa sin errores).

- [ ] **Step 9: Commit**

```bash
git add scripts/detect-official-versions.sh .github/workflows/sqlite-branches.yml .github/workflows/pages.yml
git commit -m "Anade workflow que genera las ramas sqlite por version"
```

- [ ] **Step 10: Dejar constancia de que la ejecucion real queda pendiente del secreto**

El workflow no se puede ejecutar de extremo a extremo hasta que exista `FORK_PUSH_TOKEN`
(Step 1). Lo que si se comprueba ahora es que la deteccion de versiones que usa funciona,
porque es el unico paso que no depende del secreto:

Run: `scripts/detect-official-versions.sh stable && echo && scripts/detect-official-versions.sh beta`
Expected: dos versiones del tipo `2026.41` y `2026.5`.

Las ramas de hoy se publican a mano en la Tarea 3, Step 0.

---

### Task 3: El build del playground consume la rama en vez de parchear

**Files:**
- Modify: `scripts/fetch-facturascripts-source.sh:13-38` (sustituir la rama `FS_VERSION`)
- Modify: `scripts/build-facturascripts-bundle.sh:19-61` (borrar el bloque de parcheo)
- Modify: `scripts/build-facturascripts-bundle.sh:127-135` (procedencia en el manifest)

**Interfaces:**
- Consumes: ramas `sqlite/<version>` publicadas en la Tarea 2.
- Produces: `fetch-facturascripts-source.sh` sigue imprimiendo por stdout el directorio del core, ahora siempre un clon de git.

- [ ] **Step 0: Generar y publicar las dos ramas de version**

La Tarea 1 ya dejo `sqlite/2026.41` en el clon local. Falta la beta, y falta publicar ambas:
el resto de esta tarea las necesita en el remoto para poder verificar de verdad.

```bash
FS_VERSION=2026.5 sh scripts/build-sqlite-branch.sh
cd .cache/sqlite-branch/fork
git push git@github.com:erseco/facturascripts.git sqlite/2026.41 sqlite/2026.5
cd -
```

Expected: la generacion de 2026.5 termina sin conflictos y con los `php -l` limpios, igual
que la de 2026.41, y el push crea las dos ramas.

Comprobar:

```bash
git ls-remote --heads git@github.com:erseco/facturascripts.git 'sqlite/*'
```
Expected: lista `sqlite/2026.41` y `sqlite/2026.5`.

Si la generacion de 2026.5 conflictua, PARA y reporta: significa que el delta no es tan
estable entre canales como asume el diseno, y eso es informacion que cambia el plan.

- [ ] **Step 1: Comprobar el estado de partida**

Run: `grep -c "SQLITE_COMMIT" scripts/build-facturascripts-bundle.sh`
Expected: `2` (la asignacion y los dos usos en las URLs; confirma que el bloque sigue ahi).

- [ ] **Step 2: Reescribir la resolucion de fuente**

En `scripts/fetch-facturascripts-source.sh`, sustituir el bloque completo `if [ -n "${FS_VERSION:-}" ]; then ... exit 0; fi` (lineas 13-38) por:

```sh
# Con FS_VERSION se usa la rama sqlite/<version> del fork: release oficial ya
# fusionada con el soporte SQLite por scripts/build-sqlite-branch.sh. Antes aqui
# se descargaba el zip oficial y el bundle le aplicaba un parche fijado a mano.
if [ -n "${FS_VERSION:-}" ]; then
  case "$FS_VERSION" in
    *[!0-9.]*|'')
      echo "Invalid FacturaScripts version: $FS_VERSION" >&2
      exit 1
      ;;
  esac
  REF_BRANCH="sqlite/$FS_VERSION"
fi
```

El resto del fichero (el clon/fetch y el `printf` final) queda igual y ahora sirve a los dos casos.

- [ ] **Step 3: Borrar el bloque de parcheo del bundle**

En `scripts/build-facturascripts-bundle.sh`, borrar integramente las lineas 19-61, es decir desde el comentario

```
# Official builds do not include the pending SQLite support required by the
```

hasta el `fi` que cierra el `if [ -n "${FS_VERSION:-}" ]`, ambos incluidos. Eso elimina `SQLITE_COMMIT`, la descarga del `.diff`, el filtro `awk`, el `patch -p1`, el borrado de los `.orig`, los dos `curl` y los `grep`/`php -l` de verificacion (que ahora hace `build-sqlite-branch.sh`).

- [ ] **Step 4: Arreglar la procedencia del manifest**

En `scripts/build-facturascripts-bundle.sh`, sustituir el bloque de procedencia (lineas 127-135) por:

```sh
if [ -d "$SOURCE_DIR/.git" ]; then
  SOURCE_COMMIT=$(git -C "$SOURCE_DIR" rev-parse HEAD)
  SOURCE_REPOSITORY=${FS_REF:-https://github.com/erseco/facturascripts.git}
  if [ -n "${FS_VERSION:-}" ]; then
    SOURCE_BRANCH="sqlite/$FS_VERSION"
  else
    SOURCE_BRANCH=${FS_REF_BRANCH:-feature/add-sqlite-support}
  fi
else
  echo "Se esperaba un clon de git en $SOURCE_DIR" >&2
  exit 1
fi
```

La rama `else` anterior (`SOURCE_COMMIT="official-$FS_VERSION"`) queda muerta: ahora las dos rutas clonan git, y el manifest pasa a registrar el commit real, que antes se perdia.

- [ ] **Step 5: Verificar que no queda rastro del parcheo**

Run:
```bash
grep -c "SQLITE_COMMIT\|sqlite-support.diff\|sqlite-runtime.diff" scripts/build-facturascripts-bundle.sh || echo "0 coincidencias (correcto)"
sh -n scripts/build-facturascripts-bundle.sh && sh -n scripts/fetch-facturascripts-source.sh && echo "sintaxis correcta"
```
Expected: `0 coincidencias (correcto)` y `sintaxis correcta`.

- [ ] **Step 6: Construir el bundle de verdad contra la rama**

Run: `FS_VERSION=2026.41 MANIFEST_FILE=2026.41.json UPDATE_CONFIG=false npm run bundle`
Expected: termina con `Bundle written to ...` y `Manifest written to ...`, sin mencionar parches.

- [ ] **Step 7: Comprobar el manifest**

Run: `jq '{release, sourceBranch, sourceCommit}' assets/manifests/2026.41.json`
Expected: `release` es `2026.41`, `sourceBranch` es `sqlite/2026.41` y `sourceCommit` es un SHA real de 40 caracteres (no `official-2026.41`).

- [ ] **Step 8: Comprobar que el bundle lleva SQLite**

Run:
```bash
tar --use-compress-program=unzstd -tf assets/facturascripts/facturascripts-core-2026.41.tar.zst \
  | grep -E "Core/Base/DataBase/Sqlite(Engine|Queries)\.php"
```
Expected: aparecen las dos rutas.

- [ ] **Step 9: Pasar los tests y el lint**

Run: `make test && make lint`
Expected: ambos en verde.

- [ ] **Step 10: Commit**

```bash
git add scripts/fetch-facturascripts-source.sh scripts/build-facturascripts-bundle.sh
git commit -m "Consume las ramas sqlite/<version> y elimina el parcheo en tiempo de build"
```

---

### Task 4: Documentacion y correccion del spec

**Files:**
- Modify: `AGENTS.md:126-131` (fuente por defecto del build)
- Modify: `docs/development.md` (anadir seccion)
- Modify: `docs/superpowers/specs/2026-07-31-sqlite-version-branches-design.md` (corregir vendor/node_modules)

**Interfaces:**
- Consumes: el comportamiento implementado en las Tareas 1-3.
- Produces: nada que consuma codigo.

- [ ] **Step 1: Actualizar AGENTS.md**

En `AGENTS.md`, bajo "Default build source", sustituir el bloque por:

```markdown
Default build source:

- `FS_REF=https://github.com/erseco/facturascripts.git`
- `FS_REF_BRANCH=feature/add-sqlite-support` (builds locales, sin `FS_VERSION`)
- Con `FS_VERSION=<version>` se clona la rama `sqlite/<version>` del mismo fork, que
  `.github/workflows/sqlite-branches.yml` genera con `scripts/build-sqlite-branch.sh`:
  release oficial importada como commit mas el delta SQLite aplicado con merge a 3 bandas.
  El build ya no parchea nada.
```

- [ ] **Step 2: Documentar el flujo en development.md**

Anadir al final de `docs/development.md`:

```markdown
## Ramas SQLite por version

El soporte SQLite todavia no esta en FacturaScripts upstream (PR
[#1908](https://github.com/NeoRazorX/facturascripts/pull/1908), abierta desde marzo de
2026 sin respuesta), asi que los bundles de versiones oficiales se construyen desde ramas
`sqlite/<version>` del fork `erseco/facturascripts`.

Cada rama es la release oficial importada como commit mas el delta SQLite aplicado con
merge a 3 bandas. Las genera `.github/workflows/sqlite-branches.yml` cada noche, y se
pueden generar a mano:

    make sqlite-branch VERSION=2026.41

El delta es `origin/master...feature/add-sqlite-support` restringido a `Core/`, menos una
denylist declarada en `scripts/build-sqlite-branch.sh`. La denylist existe para dejar
fuera los cambios que no son "habilitar SQLite" sino arreglos a codigo de master que la
release todavia no incluye: esos conflictuan siempre, porque parchean codigo que no esta.

Si el merge conflictua, el workflow falla y hay que resolverlo a mano. No se aplica ningun
tipo de fuzz: un parche difuso no falla, acierta mal.

Las ramas de versiones que ya no se ofrecen se pueden borrar sin mas:

    git push --delete origin sqlite/2026.3
```

- [ ] **Step 3: Corregir el spec**

En `docs/superpowers/specs/2026-07-31-sqlite-version-branches-design.md`, en el paso 1 de "Workflow de generacion", sustituir:

```
1. Descarga el zip oficial y lo importa como commit, descartando `vendor/` y
   `node_modules/` (el build los regenera con `composer install` y `npm install`).
```

por:

```
1. Descarga el zip oficial y lo importa como commit **conservando `vendor/` y
   `node_modules/`**: el zip no trae `composer.json` ni `package.json`, asi que sin ellos
   el build se queda sin dependencias y aborta. Son 29 MB y 2155 ficheros por version,
   con deduplicacion de git entre versiones.
```

Y en "Riesgos", sustituir el tercer punto por:

```
- **Tamano del repo**: cada rama de version anade el arbol completo de la release (29 MB,
  2155 ficheros). Git deduplica los blobs identicos entre versiones, de modo que el coste
  incremental es pequeno, pero conviene podar las ramas de versiones retiradas.
```

Y sustituir la seccion "Verificacion" entera por:

```
## Verificacion

La release oficial no incluye `Test/` ni `phpunit.xml`, asi que **no se puede correr la
suite de FacturaScripts contra la rama generada**. Copiar `Test/` del fork tampoco vale:
sus tests prueban codigo de master que la release no contiene, asi que fallarian por
construccion. La verificacion se hace en tres capas:

1. Dentro de `scripts/build-sqlite-branch.sh`: los `grep` de que el enganche existe
   (`use ...SqliteEngine;` y `case 'sqlite':`) mas `php -l` sobre los ficheros tocados.
2. Smoke test en el workflow: construir el bundle desde la rama recien generada y
   comprobar que contiene `SqliteEngine.php` y `SqliteQueries.php`. Es el consumidor real.
3. Los tests e2e de Playwright del playground, que arrancan el bundle en un navegador.
   Es la unica cobertura de integracion real, y ya existe.
```

- [ ] **Step 4: Verificar que la documentacion sigue construyendo**

Run: `mkdocs build --strict -d /tmp/mkdocs-check && echo "docs OK" && rm -rf /tmp/mkdocs-check`
Expected: imprime `docs OK`.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/development.md docs/superpowers/specs/2026-07-31-sqlite-version-branches-design.md
git commit -m "Documenta las ramas sqlite por version"
```

---

## Verificacion final

- [ ] `make test` y `make lint` en verde.
- [ ] `FS_VERSION=2026.41 npm run bundle` produce un bundle con `SqliteEngine.php` dentro.
- [ ] `FS_VERSION=2026.5 npm run bundle` hace lo propio con la beta.
- [ ] Un build local sin `FS_VERSION` (`make bundle`) sigue clonando `feature/add-sqlite-support` y funcionando como antes.
- [ ] `grep -rn "SQLITE_COMMIT" scripts/` no devuelve nada.
- [ ] Los tests e2e de Playwright pasan: `make test-e2e`.
