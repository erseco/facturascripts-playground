# Getting started

## Requisitos

- Node.js 18+
- npm
- Composer
- Git

Para previsualizar la documentacion localmente tambien necesitas Python 3.

## Ejecutar el playground en local

```bash
git clone https://github.com/erseco/facturascripts-playground.git
cd facturascripts-playground
make up
```

Despues abre <http://localhost:8085/>.

Credenciales por defecto:

- usuario: `admin`
- password: `admin`

## Archivos importantes

| Area | Archivo | Para que sirve |
| --- | --- | --- |
| Shell UI | `index.html`, `src/shell/main.js`, `src/styles/app.css` | Navegacion, panel lateral, import/export de blueprint y `iframe` |
| Runtime host | `remote.html`, `src/remote/main.js` | Registra el service worker y levanta el runtime scoped |
| Routing | `sw.js`, `php-worker.js` | Convierte peticiones del navegador en peticiones al runtime PHP |
| Bootstrap | `src/runtime/bootstrap.js` | Escribe `config.php`, ejecuta deploy, inicializa FacturaScripts y autologin |
| Montaje readonly | `src/runtime/vfs.js` | Monta el core readonly de FacturaScripts |
| Config global | `playground.config.json` | Titulo, locale, timezone, usuario admin, runtimes, autologin |
| Blueprint por defecto | `assets/blueprints/default.blueprint.json` | Configuracion inicial que se aplica al scope |
| Bundle readonly | `assets/facturascripts/` | Bundle readonly del core empaquetado |
| Manifiesto | `assets/manifests/latest.json` | Metadatos del bundle actual |

## Configuracion basica

### `playground.config.json`

Este archivo define los valores globales del playground. Los campos mas usados son:

- `siteTitle`
- `landingPath`
- `locale`
- `timezone`
- `autologin`
- `resetOnVersionMismatch`
- `admin.username`
- `admin.password`
- `admin.email`

### `default.blueprint.json`

El blueprint por defecto afina el comportamiento de una sesion concreta:

- `debug.enabled`
- `landingPage`
- `siteOptions.title`
- `siteOptions.locale`
- `siteOptions.timezone`
- `login.username`
- `login.password`
- `plugins`
- `seed`

El runtime normaliza este contenido en `src/shared/blueprint.js`.

Ejemplo util del repositorio:

- `blueprint-sample.json`: instala CommandPalette y crea datos demo basicos

Casos comunes:

- activar un plugin ya presente: añade su nombre a `plugins`
- instalar un plugin remoto: añade la URL directa al ZIP o `DownloadBuild`
- crear datos demo: usa `seed.customers`, `seed.suppliers` y `seed.products`

Consulta la referencia completa en `docs/blueprint-json.md`.

## Reconstruir el bundle

```bash
make bundle
```

Para compilar contra otro fork o rama de FacturaScripts:

```bash
FS_REF=https://github.com/<org>/facturascripts.git FS_REF_BRANCH=<branch> make bundle
```

Por defecto el proyecto usa:

- `FS_REF=https://github.com/erseco/facturascripts.git`
- `FS_REF_BRANCH=feature/add-sqlite-support`

## Previsualizar la documentacion

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-docs.txt
mkdocs serve
```

Abre <http://127.0.0.1:8000/>.

## Validaciones utiles

```bash
node --check src/shell/main.js
node --check src/runtime/bootstrap.js
node --check src/runtime/vfs.js
node --check sw.js
node --check php-worker.js
mkdocs build --strict
```

## Comprobaciones manuales recomendadas

- primer arranque limpio
- recarga con estado persistido
- autologin del usuario admin
- navegacion interna de FacturaScripts
- despliegue bajo subdirectorio
