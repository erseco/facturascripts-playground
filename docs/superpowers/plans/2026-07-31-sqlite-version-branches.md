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

## REDISENO (2026-07-31, posterior a la revision de la Tarea 3)

**Las Tareas 1-3 estan hechas y revisadas, pero el esquema de ramas cambia.** Lo que sigue
gobierna sobre cualquier mencion anterior a ramas `sqlite/<version>` en este documento: esas
ramas se abandonan. Las Tareas 5 y 6 implementan el cambio; las Tareas 1-3 se conservan como
registro de lo construido y se reaprovechan casi enteras.

Esquema nuevo, dos canales:

| Canal | Rama | Version | Como se mantiene |
| --- | --- | --- | --- |
| dev | `feature/add-sqlite-support` | 2026.51 | A mano. Es la rama de trabajo de siempre, con la PR #1908 abierta. **No se genera**: el build solo la clona. |
| stable | `feature/add-sqlite-support-stable` | 2026.41 | **Generada**: zip oficial del canal stable + delta SQLite, con force-push. |

Por que:

- Upstream no tiene rama `stable` (solo `master` y ramas de feature sueltas), y la stable
  vigente ni siquiera tiene tag, asi que una segunda PR no tendria destino. Una sola PR.
- Al existir siempre las dos ramas, desaparece la ventana en la que `pages.yml` fallaba por
  rama inexistente, y desaparece el podado de ramas por version.
- La regeneracion solo afecta a una rama.

Consecuencia asumida explicitamente: **el playground deja de ofrecer la beta oficial
publicada (2026.5) y pasa a ofrecer el build de desarrollo (2026.51)**. Es un cambio de
producto, no solo de fontaneria. El numero de version lo hace evidente al usuario.

Regeneracion de la rama stable: se regenera cuando cambia la version oficial del canal
stable **o** cuando cambia el delta. Para saberlo sin rehacer el trabajo cada noche, el
commit generado lleva dos trailers, `Release:` y `Delta-Id:`, y el generador compara ambos
con los del tip actual antes de decidir. `Delta-Id` es un hash determinista del contenido del
delta, no del commit, para que no dependa de marcas de tiempo.

Las ramas `sqlite/2026.41` y `sqlite/2026.5` quedan obsoletas, pero **no se borran hasta que
el reemplazo funcione**.

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
        # El input se pasa por `env:` y se lee como `$INPUT_VERSION`. Interpolar
        # `${{ inputs.version }}` dentro del `run:` seria inyeccion de comandos:
        # GitHub sustituye el texto antes de que el shell lo vea, asi que un
        # valor con comillas o backticks ejecutaria codigo en el runner.
        env:
          INPUT_VERSION: ${{ inputs.version }}
        run: |
          set -euo pipefail

          if [[ -n "$INPUT_VERSION" ]]; then
            matrix=$(jq -nc --arg v "$INPUT_VERSION" '{version: [$v]}')
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
Expected: `4` (la asignacion y los tres usos en las URLs; confirma que el bloque sigue ahi).

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

Run: `jq '{release, source}' assets/manifests/2026.41.json`
Expected: `release` es `2026.41`, y bajo la clave anidada `source` aparecen `branch` = `sqlite/2026.41` y `commit` = un SHA real de 40 caracteres (no `official-2026.41`). generate-manifest.mjs anida esas claves, no las deja planas.

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

> **OBSOLETO A PARTIR DE AQUI.** Los pasos de esta tarea se escribieron antes del
> rediseno y describen ramas `sqlite/<version>` y la variable `FS_VERSION`, que ya no
> existen. **Ejecuta en su lugar la Tarea 7**, que cubre lo mismo actualizado y ampliado.
> Se conserva este texto como registro de lo que se planifico.

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

### Task 5: Generador de la rama stable unica

**Files:**
- Modify: `scripts/build-sqlite-branch.sh` (rama destino fija, trailers, salto si no hay cambios)
- Modify: `.github/workflows/sqlite-branches.yml` (un solo job, sin matriz)

**Interfaces:**
- Consumes: `scripts/detect-official-versions.sh stable` (Tarea 2).
- Produces: `sh scripts/build-sqlite-branch.sh` sin argumentos genera o actualiza
  `feature/add-sqlite-support-stable` en `$WORK_DIR/fork`. Imprime por stdout el SHA
  resultante, o la cadena `SIN-CAMBIOS` si el tip ya estaba al dia. No hace push.

- [ ] **Step 1: Reemplazar la seleccion de version y de rama destino**

En `scripts/build-sqlite-branch.sh`, sustituir el bloque que exige `FS_VERSION` y calcula
`TARGET_BRANCH="sqlite/$FS_VERSION"` por:

```sh
# La version sale del canal oficial stable, no de un argumento: la rama destino es
# unica y siempre representa "la ultima stable + SQLite".
FS_VERSION=${FS_VERSION:-$("$SCRIPT_DIR/detect-official-versions.sh" stable)}
case "$FS_VERSION" in
  *[!0-9.]*|'') echo "Version invalida: $FS_VERSION" >&2; exit 1 ;;
esac

TARGET_BRANCH=${FS_TARGET_BRANCH:-"feature/add-sqlite-support-stable"}
```

`FS_VERSION` se conserva como override opcional para poder regenerar contra una version
concreta sin tocar el script.

- [ ] **Step 2: Calcular el identificador del delta**

Justo despues de calcular `DELTA_FILES`, anadir:

```sh
# Identificador determinista del CONTENIDO del delta: par ruta/blob de cada fichero,
# hasheado. No depende de marcas de tiempo ni del SHA del commit sintetizado, asi que
# dos ejecuciones con el mismo delta dan el mismo valor.
DELTA_ID=$(
  echo "$DELTA_FILES" | while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s %s\n' "$f" "$(git -C "$FORK_DIR" rev-parse "$REF_BRANCH:$f" 2>/dev/null || echo ausente)"
  done | git hash-object --stdin
)
```

- [ ] **Step 3: Saltar el trabajo si el tip ya esta al dia**

Antes de descargar el zip, anadir:

```sh
# Si la rama destino ya se genero con esta misma version y este mismo delta, no hay
# nada que hacer. Evita reescribir la rama cada noche sin motivo.
if git -C "$FORK_DIR" rev-parse --verify --quiet "origin/$TARGET_BRANCH" >/dev/null; then
  TIP_MSG=$(git -C "$FORK_DIR" log -1 --format=%B "origin/$TARGET_BRANCH")
  TIP_RELEASE=$(printf '%s\n' "$TIP_MSG" | sed -n 's/^Release: //p' | tail -1)
  TIP_DELTA=$(printf '%s\n' "$TIP_MSG" | sed -n 's/^Delta-Id: //p' | tail -1)
  if [ "$TIP_RELEASE" = "$FS_VERSION" ] && [ "$TIP_DELTA" = "$DELTA_ID" ]; then
    echo "La rama $TARGET_BRANCH ya esta al dia (release $FS_VERSION, delta $DELTA_ID)." >&2
    echo "SIN-CAMBIOS"
    exit 0
  fi
fi
```

Para que `origin/$TARGET_BRANCH` exista, el `fetch` del paso 1 del script debe incluirla.
Cambiar ese `fetch` para que no falle si la rama todavia no existe en el remoto:

```sh
  git -C "$FORK_DIR" fetch origin "$BASE_BRANCH" "$REF_BRANCH" >&2
  git -C "$FORK_DIR" fetch origin "$TARGET_BRANCH" >&2 || true
```

- [ ] **Step 4: Escribir los trailers en el commit generado**

En el commit de importacion de la release, sustituir su mensaje por uno con los trailers,
de modo que el cherry-pick posterior los conserve en el historial de la rama. Como el
cherry-pick anade su propio commit encima, los trailers deben ir en el commit FINAL: tras
el cherry-pick, anadir

```sh
git -C "$FORK_DIR" commit -q --amend -m "SQLite sobre la release oficial $FS_VERSION

Rama generada automaticamente por scripts/build-sqlite-branch.sh.
No commitear a mano: se reescribe con force-push cuando cambia la
release oficial del canal stable o cuando cambia el delta SQLite.

Release: $FS_VERSION
Delta-Id: $DELTA_ID"
```

- [ ] **Step 5: Verificar la generacion y el salto**

Run: `sh scripts/build-sqlite-branch.sh`
Expected: genera la rama, sin conflictos, los `php -l` limpios, y la ultima linea es un SHA.

Run de nuevo, sin cambiar nada: `sh scripts/build-sqlite-branch.sh`
Expected: **la segunda vez tambien regenera**, porque el salto compara contra
`origin/$TARGET_BRANCH` y la rama aun no esta publicada. Es correcto. El salto se verifica de
verdad en el Step 7, tras publicar.

Comprobar los trailers:

```bash
git -C .cache/sqlite-branch/fork log -1 --format=%B feature/add-sqlite-support-stable
```
Expected: incluye una linea `Release: 2026.41` y otra `Delta-Id: <hash>`.

- [ ] **Step 6: Publicar la rama**

```bash
cd .cache/sqlite-branch/fork
git push --force git@github.com:erseco/facturascripts.git feature/add-sqlite-support-stable
cd -
git ls-remote --heads git@github.com:erseco/facturascripts.git 'feature/*'
```
Expected: lista `feature/add-sqlite-support` y `feature/add-sqlite-support-stable`.

- [ ] **Step 7: Verificar que el salto funciona de verdad**

Run: `sh scripts/build-sqlite-branch.sh`
Expected: imprime por stderr `La rama feature/add-sqlite-support-stable ya esta al dia` y por
stdout exactamente `SIN-CAMBIOS`. Este es el paso que demuestra que no se reescribe la rama
sin motivo.

- [ ] **Step 8: Simplificar el workflow a un solo job**

En `.github/workflows/sqlite-branches.yml`: eliminar el job `versions` y la matriz, y dejar un
unico job que genera y publica. Sustituir el guard `git ls-remote --exit-code` por la salida
del propio script: si imprime `SIN-CAMBIOS`, no se publica.

```yaml
      - name: Generar la rama stable
        id: gen
        env:
          WORK_DIR: ${{ runner.temp }}/sqlite-branch
        run: |
          set -euo pipefail
          RESULT=$(sh scripts/build-sqlite-branch.sh)
          echo "resultado=$RESULT" >> "$GITHUB_OUTPUT"
          if [ "$RESULT" = "SIN-CAMBIOS" ]; then
            echo "La rama ya estaba al dia; no hay nada que publicar."
          fi

      - name: Publicar la rama
        if: steps.gen.outputs.resultado != 'SIN-CAMBIOS'
        env:
          WORK_DIR: ${{ runner.temp }}/sqlite-branch
          TOKEN: ${{ secrets.FORK_PUSH_TOKEN }}
        run: |
          set -euo pipefail
          cd "$WORK_DIR/fork"
          git push --force \
            "https://x-access-token:${TOKEN}@github.com/erseco/facturascripts.git" \
            feature/add-sqlite-support-stable
```

El smoke test se mantiene entre ambos, con la misma condicion que "Publicar", construyendo
con `FS_CHANNEL=stable` (ver Tarea 6).

- [ ] **Step 9: Validar y commitear**

```bash
sh -n scripts/build-sqlite-branch.sh
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/sqlite-branches.yml')); print('YAML valido')"
git add scripts/build-sqlite-branch.sh .github/workflows/sqlite-branches.yml
git commit -m "Genera una unica rama stable y la regenera solo si cambia el delta"
```

---

### Task 6: El build consume canales, no versiones

**Files:**
- Modify: `scripts/fetch-facturascripts-source.sh` (canal en vez de version)
- Modify: `scripts/build-facturascripts-bundle.sh` (procedencia por canal)
- Modify: `.github/workflows/pages.yml` (matriz de canales)
- Modify: `Makefile` (target `sqlite-branch` sin VERSION)

**Interfaces:**
- Consumes: las dos ramas del esquema nuevo.
- Produces: `FS_CHANNEL=stable|dev` como variable que elige la fuente. `FS_VERSION` deja de
  usarse en el build.

- [ ] **Step 1: Sustituir FS_VERSION por FS_CHANNEL en la resolucion de fuente**

En `scripts/fetch-facturascripts-source.sh`, sustituir el bloque de `FS_VERSION` por:

```sh
# El canal elige la rama. Ambas existen siempre, asi que el build nunca falla por una
# rama que todavia no se ha generado.
if [ -n "${FS_CHANNEL:-}" ]; then
  case "$FS_CHANNEL" in
    stable) REF_BRANCH="feature/add-sqlite-support-stable" ;;
    dev)    REF_BRANCH="feature/add-sqlite-support" ;;
    *) echo "Canal invalido: $FS_CHANNEL (usa stable o dev)" >&2; exit 1 ;;
  esac
fi
```

- [ ] **Step 2: Ajustar la procedencia del manifest**

En `scripts/build-facturascripts-bundle.sh`, el bloque de procedencia deja de reconstruir el
nombre de la rama: se lee del artefacto real, que es la unica fuente que no puede mentir.

```sh
if [ -d "$SOURCE_DIR/.git" ]; then
  SOURCE_COMMIT=$(git -C "$SOURCE_DIR" rev-parse HEAD)
  SOURCE_REPOSITORY=${FS_REF:-https://github.com/erseco/facturascripts.git}
  SOURCE_BRANCH=$(git -C "$SOURCE_DIR" rev-parse --abbrev-ref HEAD)
else
  echo "Se esperaba un clon de git en $SOURCE_DIR" >&2
  exit 1
fi
```

Esto cierra de paso el minor M1 de la revision de la Tarea 3: el nombre ya no se deriva en
dos sitios que puedan divergir en silencio.

- [ ] **Step 3: Matriz de canales en pages.yml**

En `.github/workflows/pages.yml`, el job `discover-versions` pasa a resolver las dos versiones
asi: la stable del canal oficial, y la dev leyendo `Core/Kernel.php` de la rama de trabajo sin
clonarla.

```bash
          stable=$(scripts/detect-official-versions.sh stable)
          dev=$(curl --fail --silent --show-error --location \
            'https://raw.githubusercontent.com/erseco/facturascripts/feature/add-sqlite-support/Core/Kernel.php' \
            | sed -nE 's/.*return[[:space:]]+([0-9]+\.[0-9]+).*/\1/p' | head -1)
          [ -n "$dev" ] || { echo "No se pudo leer la version de la rama dev" >&2; exit 1; }

          matrix=$(jq -nc --arg s "$stable" --arg d "$dev" \
            '{include: [{channel: "stable", version: $s}, {channel: "dev", version: $d}]}')
          index=$(jq -nc --arg s "$stable" --arg d "$dev" \
            '{schemaVersion: 1, default: $s, versions: [{version: $s, channels: ["stable"], label: ($s + " (Stable)")}, {version: $d, channels: ["dev"], label: ($d + " (Desarrollo)")}]}')
```

Y en `build-core`, `FS_VERSION: ${{ matrix.version }}` pasa a `FS_CHANNEL: ${{ matrix.channel }}`.
`MANIFEST_FILE` sigue usando `${{ matrix.version }}`, porque el manifest se nombra por version.

- [ ] **Step 4: Ajustar el target del Makefile**

El target `sqlite-branch` ya no recibe `VERSION`:

```make
sqlite-branch:
	FS_REF=$(FS_REF) FS_REF_BRANCH=$(FS_REF_BRANCH) sh scripts/build-sqlite-branch.sh
```

- [ ] **Step 5: Verificar los dos canales de verdad**

```bash
FS_CHANNEL=stable MANIFEST_FILE=stable.json UPDATE_CONFIG=false npm run bundle
jq '{release, source}' assets/manifests/stable.json
FS_CHANNEL=dev MANIFEST_FILE=dev.json UPDATE_CONFIG=false npm run bundle
jq '{release, source}' assets/manifests/dev.json
```
Expected: el primero da `release` 2026.41 y `source.branch` `feature/add-sqlite-support-stable`;
el segundo da `release` 2026.51 y `source.branch` `feature/add-sqlite-support`.

- [ ] **Step 6: Comprobar que la ruta local sigue intacta**

Run: `make bundle`
Expected: funciona igual que antes, clonando `feature/add-sqlite-support` sin `FS_CHANNEL`.

- [ ] **Step 7: Tests, lint y commit**

```bash
make test && make lint
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/pages.yml')); print('pages.yml valido')"
git add scripts/ .github/workflows/pages.yml Makefile
git commit -m "El build elige la fuente por canal en vez de por version"
```

---

### Task 7: Documentacion del esquema de canales y retirada de lo viejo

**Files:**
- Modify: `AGENTS.md:127-131` (fuente por defecto del build)
- Modify: `docs/development.md` (seccion nueva)
- Modify: `CHANGELOG-TECHNICAL.md` (entrada nueva, no reescribir la vieja)
- Modify: `docs/superpowers/specs/2026-07-31-sqlite-version-branches-design.md`
- Modify: este plan, seccion "Verificacion final"

**Interfaces:**
- Consumes: el comportamiento de las Tareas 5 y 6.
- Produces: nada que consuma codigo.

- [ ] **Step 1: Actualizar AGENTS.md**

Sustituir el bloque "Default build source" por:

```markdown
Default build source:

- `FS_REF=https://github.com/erseco/facturascripts.git`
- `FS_REF_BRANCH=feature/add-sqlite-support` (builds locales, sin `FS_CHANNEL`)

Con `FS_CHANNEL` el build elige entre dos ramas fijas del fork:

- `FS_CHANNEL=dev` -> `feature/add-sqlite-support`. Rama de trabajo, mantenida a mano,
  con la PR abierta a upstream. El build solo la lee.
- `FS_CHANNEL=stable` -> `feature/add-sqlite-support-stable`. Generada por
  `scripts/build-sqlite-branch.sh`: release oficial del canal stable mas el delta SQLite
  aplicado con merge a 3 bandas. Se reescribe con force-push, no commitear a mano.

El build ya no parchea nada en tiempo de construccion.
```

- [ ] **Step 2: Documentar el flujo en development.md**

Anadir al final de `docs/development.md`:

```markdown
## Canales SQLite

El soporte SQLite todavia no esta en FacturaScripts upstream (PR
[#1908](https://github.com/NeoRazorX/facturascripts/pull/1908), abierta desde marzo de 2026
sin respuesta), asi que el playground construye desde dos ramas del fork
`erseco/facturascripts`:

| Canal | Rama | Como se mantiene |
| --- | --- | --- |
| `dev` | `feature/add-sqlite-support` | A mano. Es la rama de la PR. |
| `stable` | `feature/add-sqlite-support-stable` | Generada, se reescribe con force-push. |

La rama stable se genera con:

    make sqlite-branch

Es la release oficial del canal stable importada como commit, mas el delta SQLite aplicado
con `git cherry-pick`. El merge a 3 bandas es deliberado: `patch` falla ante la deriva de
contexto entre master y una release antigua, y `patch --fuzz` es peor, porque no falla sino
que acierta mal y deja el build en verde con el codigo descolocado.

El delta es `origin/master...feature/add-sqlite-support` restringido a `Core/`, menos una
denylist declarada en el script. La denylist existe para dejar fuera lo que no es "habilitar
SQLite" sino arreglos a codigo de master que la release todavia no incluye: esos conflictuan
siempre, porque parchean codigo que no esta.

El commit generado lleva tres trailers -- `Release:`, `Delta-Id:` y `Generator-Id:` -- y la
rama solo se regenera si alguno cambia. `Generator-Id` es el hash del propio script: sin el,
un cambio en la logica de generacion no llegaria nunca a desplegarse.

Si el merge conflictua, el workflow falla y hay que resolverlo a mano.

**Limitacion conocida:** los manifests se nombran por version, asi que si la version del
canal stable llegara a coincidir con la de la rama dev, ambos colisionarian. El workflow lo
detecta y aborta con un mensaje explicito. El arreglo de fondo es indexar los manifests por
canal, pendiente.
```

- [ ] **Step 3: Anadir una entrada nueva al CHANGELOG**

`CHANGELOG-TECHNICAL.md` es un registro de decisiones fechadas: la entrada
"Supported FacturaScripts release channels" del 2026-07-22 describe correctamente lo que se
decidio entonces y **no se reescribe**. Anadir una entrada nueva encima de ella:

```markdown
## SQLite por canal en vez de por version

**Date:** 2026-07-31
**Context:** El parche SQLite se aplicaba en tiempo de build desde un commit fijado a mano,
asi que los arreglos posteriores al pin no llegaban nunca al despliegue.

### Decision

- El playground construye desde dos ramas fijas del fork, elegidas por `FS_CHANNEL`:
  `feature/add-sqlite-support` (dev) y `feature/add-sqlite-support-stable` (stable).
- La rama stable se genera con `scripts/build-sqlite-branch.sh`: release oficial importada
  como commit mas el delta SQLite aplicado con `git cherry-pick`. Se sustituye asi el
  `patch` en tiempo de build, que fracasaba ante la deriva de contexto entre master y una
  release antigua.
- La regeneracion se decide comparando tres trailers del commit tip (`Release:`,
  `Delta-Id:`, `Generator-Id:`), de modo que la rama no se reescribe sin motivo pero si
  recoge cambios del delta o de la propia logica de generacion.
- El bloque de parcheo de `build-facturascripts-bundle.sh` desaparece, y la procedencia del
  manifest pasa a leerse del artefacto real en vez de reconstruirse.

Esto **deja sin efecto** el punto de la entrada anterior que decia que los ZIP oficiales
reciben la porcion runtime del commit SQLite fijado. Tambien cambia lo que se ofrece: el
canal beta oficial se sustituye por el build de desarrollo de la rama de trabajo.

**Files:** `.github/workflows/pages.yml`, `.github/workflows/sqlite-branches.yml`,
`scripts/build-sqlite-branch.sh`, `scripts/detect-official-versions.sh`,
`scripts/fetch-facturascripts-source.sh`, `scripts/build-facturascripts-bundle.sh`,
`src/shared/core-versions.js`
```

- [ ] **Step 4: Poner el spec al dia**

En `docs/superpowers/specs/2026-07-31-sqlite-version-branches-design.md`, el documento
describe el esquema de ramas por version, que se abandono. Anadir al principio, justo
despues de la fecha:

```markdown
> **Nota posterior (2026-07-31).** Este diseno se implemento y despues se simplifico: en vez
> de una rama por version publicada, hay dos ramas fijas por canal
> (`feature/add-sqlite-support` para dev, `feature/add-sqlite-support-stable` para stable).
> El razonamiento y las mediciones de este documento siguen siendo validos; lo que cambia es
> que no hay proliferacion de ramas ni ventana en la que una rama no exista todavia.
> Ver la seccion REDISENO del plan de implementacion.
```

Y aplicar las tres correcciones ya identificadas: conservar `vendor/` y `node_modules/` al
importar el zip (el zip no trae `composer.json` ni `package.json`), sustituir el riesgo del
podado de ramas por el del tamano del repo, y reescribir la seccion "Verificacion", que
prometia correr la suite de tests contra la rama generada -- inviable, porque la release
oficial no incluye `Test/` ni `phpunit.xml`.

- [ ] **Step 5: Actualizar la verificacion final del plan**

En este mismo plan, la seccion "Verificacion final" cita `FS_VERSION=2026.41` y
`FS_VERSION=2026.5`, que ya no se leen. Sustituir esas dos lineas por las equivalentes con
`FS_CHANNEL=stable` y `FS_CHANNEL=dev`, y la de `grep -rn "SQLITE_COMMIT"` se conserva.

- [ ] **Step 6: Verificar que la documentacion construye**

Run: `mkdocs build --strict -d /tmp/mkdocs-check && echo "docs OK" && rm -rf /tmp/mkdocs-check`
Expected: imprime `docs OK`.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md docs/development.md CHANGELOG-TECHNICAL.md docs/superpowers/
git commit -m "Documenta el esquema de canales SQLite"
```

- [ ] **Step 8: Retirar las ramas obsoletas**

Solo despues de que todo lo anterior este verificado. Las ramas `sqlite/2026.41` y
`sqlite/2026.5` quedaron del esquema anterior y ya no las usa nada:

```bash
git ls-remote --heads git@github.com:erseco/facturascripts.git 'sqlite/*'
git push --delete git@github.com:erseco/facturascripts.git sqlite/2026.41 sqlite/2026.5
git ls-remote --heads git@github.com:erseco/facturascripts.git
```
Expected: la primera orden las lista, la ultima muestra que solo quedan
`feature/add-sqlite-support`, `feature/add-sqlite-support-stable`, `master` y las demas ramas
preexistentes del fork.

**No borres ninguna otra rama.** En particular `feature/add-sqlite-support` es la rama de
trabajo con la PR #1908 abierta.

---

## Verificacion final

- [ ] `make test` y `make lint` en verde.
- [ ] `FS_CHANNEL=stable npm run bundle` produce un bundle con `SqliteEngine.php` dentro.
- [ ] `FS_CHANNEL=dev npm run bundle` hace lo propio con la rama de trabajo.
- [ ] Un build local sin `FS_VERSION` (`make bundle`) sigue clonando `feature/add-sqlite-support` y funcionando como antes.
- [ ] `grep -rn "SQLITE_COMMIT" scripts/` no devuelve nada.
- [ ] Los tests e2e de Playwright pasan: `make test-e2e`.
