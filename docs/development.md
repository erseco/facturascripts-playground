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
make serve
```

Comprobaciones de sintaxis utiles:

```bash
node --check src/shell/main.js
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/vfs.js
```

## Bundles y fuente de FacturaScripts

El bundle readonly se genera con `scripts/build-facturascripts-bundle.sh`.

Variables de entorno soportadas:

- `FS_REF`: repositorio fuente de FacturaScripts
- `FS_REF_BRANCH`: rama a usar
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

## Cuando debes actualizar docs

Actualiza la documentacion en la misma PR si tocas:

- `playground.config.json`
- `assets/blueprints/default.blueprint.json`
- el flujo de arranque en `src/runtime/bootstrap.js`
- el modelo de almacenamiento o manifiesto
- el proceso de build del bundle
- la navegacion de la shell o el routing del service worker
