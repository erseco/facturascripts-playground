# Development

## Flujo recomendado

El flujo mas seguro para cambios en este repositorio es:

1. localizar la capa afectada
2. hacer el cambio minimo necesario
3. ejecutar las comprobaciones mas cercanas al cambio
4. validar manualmente el arranque y la navegacion si tocaste runtime o routing
5. actualizar documentacion si cambian comportamiento, configuracion o build

## Comandos de desarrollo

```bash
make deps
make prepare
make bundle
make test
make test-e2e
make lint
make serve
```

Comprobaciones de sintaxis utiles:

```bash
node --check src/shell/main.js
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/addons.js
node --check src/runtime/crash-recovery.js
node --check src/runtime/manifest.js
node --check src/runtime/networking.js
node --check src/runtime/php-compat.js
node --check src/runtime/php-loader.js
node --check src/runtime/wizard-script.js
node --check src/runtime/vfs.js
node --check src/shared/blueprint.js
node --check src/shared/config.js
node --check src/shared/paths.js
node --check src/shared/storage.js
```

## El Build ID

Cada build se sella con un **Build ID** que identifica un artefacto desplegado
concreto:

```text
20260816T065012Z-9e39f37d
└─ hora UTC del build ─┘ └ commit ┘
```

Deliberadamente **no** es una versión semántica: el playground publica en
*rolling release*. Como la marca de tiempo es la del *build* (no la del commit),
reconstruir un commit sin cambios genera un ID nuevo. Esto importa especialmente
aquí: `pages.yml` se ejecuta cada noche (`cron: "23 4 * * *"`) y vuelve a
desplegar el mismo commit cuando upstream publica un core nuevo.

```text
20260816T065012Z-9e39f37d   # reconstruccion nocturna
20260817T042301Z-9e39f37d   # mismo codigo, artefacto distinto
```

Un build local anade `-dirty` si el arbol de trabajo tiene cambios sin commitear.
Los builds de CI nunca son *dirty*.

Generarlo en local — `make prepare` y `make test` ya lo hacen por ti:

```bash
npm run build:version                                 # escribe los ficheros de metadatos
node scripts/write-build-version.mjs --print-version  # imprime solo el ID
BUILD_VERSION=20260816T065012Z-9e39f37d npm run build:version   # fija un ID exacto
```

Donde consultarlo:

| Donde | Que obtienes |
|-------|--------------|
| Panel Info → **Runtime → Playground build** | El build en ejecucion; clic para copiar. |
| Log de runtime | Una linea `Playground build …` al arrancar. |
| `assets/build-version.json` | `buildVersion`, `generatedAt`, `gitSha`, `dirty`. |
| `src/generated/build-version.js` | `BUILD_VERSION` para el codigo de la app. |
| Sentry | El `release` del issue. |

Ambos ficheros generados estan en `.gitignore`: ningun identificador se mantiene a
mano. Esto sustituye al esquema anterior, en el que `scripts/esbuild.worker.mjs`
escribia un hash de contenido del worker bundle en un `src/generated/build-version.js`
**versionado en git** — ese valor no distinguia dos builds del mismo codigo y
ensuciaba el historial.

El workflow `Deploy Pages` calcula el ID una sola vez y lo exporta por
`$GITHUB_ENV`, de modo que todos los pasos posteriores reutilizan ese valor exacto y
el artefacto de GitHub Pages y el despliegue en Cloudflare Pages del mismo `_site`
reportan el mismo build.

El Build ID es ademas la version de cache: da nombre a la cache `fs-dist-…` del
Service Worker (al activarse elimina las generaciones anteriores), al registro
`sw.js?v=…` y a la URL versionada del worker. **No** versiona los datos persistentes
del usuario: desplegar invalida la cache de codigo sin borrar el sitio de quien
visita.

El Build ID identifica al Playground, nunca a la version de FacturaScripts que se
ejecuta dentro — se muestran por separado.

## Bundles y fuente de FacturaScripts

El bundle readonly se genera con `scripts/build-facturascripts-bundle.sh`.

El workflow de Pages resuelve dos canales: la versión `stable` desde
`facturascripts.com` y la de desarrollo leyendo `Core/Kernel.php` de la rama de
trabajo del fork. Publica un manifiesto por versión junto a
`assets/manifests/versions.json`. Si ambas versiones coincidieran, el workflow
aborta con un mensaje explícito en vez de publicar, porque los manifiestos se
nombran por versión y colisionarían.

Variables de entorno soportadas:

- `FS_REF`: repositorio fuente de FacturaScripts
- `FS_REF_BRANCH`: rama a usar
- `FS_CHANNEL`: canal a construir, `stable` o `dev`. Si se define, elige la rama y tiene
  prioridad sobre `FS_REF_BRANCH`. Sin definir, se usa `FS_REF_BRANCH`.
- `WORK_DIR`: directorio temporal del build
- `DIST_DIR`: salida del bundle
- `MANIFEST_DIR`: salida del manifiesto

Ejemplo:

```bash
FS_REF=https://github.com/<org>/facturascripts.git FS_REF_BRANCH=<branch> make bundle
```

## Mantenimiento de la documentacion

La fuente de la documentacion vive en `docs/` y la configuracion de MkDocs en `mkdocs.yml`.

### Preview local

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-docs.txt
mkdocs serve
```

### Build local

```bash
mkdocs build --strict
```

## Publicacion en GitHub Pages

El workflow de `.github/workflows/pages.yml`:

1. instala dependencias Node, PHP y Python
2. prepara el runtime
3. construye el bundle de FacturaScripts
4. genera la documentacion con MkDocs en `dist/docs`
5. publica app y docs juntas

El proyecto esta preparado para desplegarse como sitio estatico, tanto en raiz como en subdirectorio.

## Tests

`make test` ejecuta la suite de `node --test` en `tests/*.test.mjs`. Hoy cubre helpers puros de `src/shared/` y `src/runtime/`, mas el generador del wizard.

`make test-e2e` ejecuta Playwright contra una instancia local levantada con `make up`. Estas pruebas cubren el shell, los paneles laterales y la persistencia basica de la UI.

Cuando cambies runtime, routing o almacenamiento, usa esa suite como primer filtro y complementala con verificacion manual en navegador.

## Cuando debes actualizar docs

Actualiza la documentacion en la misma PR si tocas:

- `playground.config.json`
- `assets/blueprints/default.blueprint.json`
- el flujo de arranque en `src/runtime/bootstrap.js`
- el modelo de almacenamiento o manifiesto
- el proceso de build del bundle
- la navegacion de la shell o el routing del service worker

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

El workflow `.github/workflows/sqlite-branches.yml` publica la rama generada con el secreto
`FORK_PUSH_TOKEN`, que necesita permiso de escritura de contenidos sobre
`erseco/facturascripts`. Sin ese secreto la generacion automatica no puede publicar y el
workflow aborta antes del push.

Si el merge conflictua, el workflow falla y hay que resolverlo a mano.

**Limitacion conocida:** los manifests se nombran por version, asi que si la version del
canal stable llegara a coincidir con la de la rama dev, ambos colisionarian. El workflow lo
detecta y aborta con un mensaje explicito. El arreglo de fondo es indexar los manifests por
canal, pendiente.
