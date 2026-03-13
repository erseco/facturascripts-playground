# FacturaScripts Playground

> FacturaScripts en el navegador con WebAssembly y sin servidor tradicional.

FacturaScripts Playground ejecuta una instancia completa de [FacturaScripts](https://facturascripts.com) dentro del navegador usando [`php-cgi-wasm`](https://www.npmjs.com/package/php-cgi-wasm). El core se monta como imagen readonly y el estado mutable se guarda en el almacenamiento del navegador.

[FacturaScripts](https://facturascripts.com/) | [Documentacion oficial](https://facturascripts.com/ayuda) | [Codigo fuente de FacturaScripts](https://github.com/NeoRazorX/facturascripts)

## Inicio rapido

```bash
git clone https://github.com/erseco/facturascripts-playground.git
cd facturascripts-playground
make up
```

Abre <http://localhost:8085>.

Credenciales por defecto:

- usuario: `admin`
- password: `admin`

La configuracion base esta en [playground.config.json](playground.config.json).

## Requisitos

- Node.js 18+
- npm
- Composer
- Git

## Comandos principales

| Comando | Descripcion |
| --- | --- |
| `make deps` | Instala dependencias npm |
| `make prepare` | Sincroniza dependencias del runtime y prepara assets WASM |
| `make bundle` | Descarga FacturaScripts, ejecuta Composer, instala assets frontend y genera el bundle readonly |
| `make serve` | Arranca el servidor local en `PORT` (por defecto `8085`) |
| `make up` | Ejecuta `make bundle` y luego `make serve` |
| `make clean` | Limpia cache y artefactos generados |

Overrides utiles:

```bash
PORT=9090 make serve
FS_REF=https://github.com/<org>/facturascripts.git FS_REF_BRANCH=<branch> make bundle
```

## Como funciona

```text
index.html          Shell UI
  -> src/shell/main.js
     -> remote.html
        -> src/remote/main.js
           -> sw.js
              -> php-worker.js
                 -> src/runtime/bootstrap.js
                 -> src/runtime/vfs.js
                 -> php-cgi-wasm
```

En cada arranque, el runtime:

1. Carga el manifiesto de `assets/manifests/latest.json`.
2. Monta el core readonly de FacturaScripts desde `assets/facturascripts/`.
3. Crea directorios mutables bajo `/persist` y `/www/facturascripts`.
4. Genera `config.php` y `php.ini` para SQLite, locale y timezone.
5. Ejecuta el deploy interno de FacturaScripts para compilar vistas y assets.
6. En el primer arranque, dispara la inicializacion y crea el usuario admin.
7. Si `autologin` esta activado, inyecta las cookies de sesion automaticamente.

## Configuracion

La configuracion del playground se divide en dos capas:

### 1. Configuracion global

Archivo: [playground.config.json](playground.config.json)

Campos relevantes:

- `bundleVersion`: version logica del playground.
- `defaultBlueprintUrl`: blueprint cargado por defecto.
- `siteTitle`: titulo base de la instancia.
- `landingPath`: ruta inicial tras el arranque.
- `locale`: locale por defecto, por ejemplo `es_ES`.
- `timezone`: zona horaria por defecto.
- `autologin`: inicia sesion automaticamente con el usuario admin.
- `resetOnVersionMismatch`: limpia el estado persistido si cambia el bundle.
- `admin.username`, `admin.password`, `admin.email`: usuario inicial.
- `runtimes[]`: runtimes PHP disponibles para la UI.

### 2. Configuracion por blueprint

Archivo por defecto: [assets/blueprints/default.blueprint.json](assets/blueprints/default.blueprint.json)

El blueprint permite definir:

- `meta`: titulo, autor y descripcion.
- `debug.enabled`: activa errores PHP visibles en navegador.
- `landingPage`: pagina de aterrizaje dentro de FacturaScripts.
- `siteOptions.title`, `siteOptions.locale`, `siteOptions.timezone`: valores efectivos de la instancia.
- `login.username`, `login.password`: credenciales que se aplican al arranque.
- `plugins`: listado declarativo de plugins por nombre, URL de ficha o URL ZIP.
- `seed`: datos demo idempotentes para clientes, proveedores y productos.

Se puede cargar un blueprint de tres formas:

- `?blueprint=/ruta/al/archivo.json`
- `?blueprint-data=...` con JSON codificado en base64url
- importando JSON desde el panel lateral de la shell

Ejemplo listo para usar:

- [blueprint-sample.json](blueprint-sample.json): instala CommandPalette y crea cliente, proveedor y producto demo

## Soporte de plugins y seed

El runtime materializa el blueprint despues de la instalacion inicial de FacturaScripts:

- si `plugins[]` contiene un nombre, intenta activarlo desde el runtime actual
- si `plugins[]` contiene una URL `http` o `https`, resuelve el ZIP cuando hace falta, lo instala y lo activa
- `seed` hace upsert de `customers`, `suppliers` y `products` para evitar duplicados al recargar
- el estado aplicado del blueprint se persiste en `/persist/mutable/config/blueprint-state.json`
- las descargas remotas usan `/__addon_proxy__` en local y `zip-proxy.erseco.workers.dev` en despliegues estaticos

Referencia tecnica: [src/runtime/addons.js](src/runtime/addons.js)

## Ejemplos de uso

Activar un plugin ya presente en el runtime:

```json
{
  "plugins": [
    "MiPlugin"
  ]
}
```

Instalar un plugin remoto desde FacturaScripts:

```json
{
  "plugins": [
    "https://facturascripts.com/plugins/commandpalette"
  ]
}
```

Instalar un plugin desde GitHub para probar una rama o un PR:

```json
{
  "plugins": [
    "https://github.com/<owner>/<repo>/tree/<branch>",
    "https://github.com/<owner>/<repo>/pull/123"
  ]
}
```

Crear datos demo idempotentes:

```json
{
  "seed": {
    "customers": [
      {
        "codcliente": "CDEMO1",
        "nombre": "Cliente Demo"
      }
    ],
    "suppliers": [
      {
        "codproveedor": "PDEMO1",
        "nombre": "Proveedor Demo"
      }
    ],
    "products": [
      {
        "referencia": "SKU-DEMO-001",
        "descripcion": "Producto demo",
        "precio": 19.95
      }
    ]
  }
}
```

Referencia completa: [docs/blueprint-json.md](docs/blueprint-json.md)

## Bundle de FacturaScripts

El bundle readonly se construye con [scripts/build-facturascripts-bundle.sh](scripts/build-facturascripts-bundle.sh).

Por defecto usa:

- repo fuente: `https://github.com/erseco/facturascripts.git`
- rama: `feature/add-sqlite-support`

Durante el build:

- se clona o actualiza el codigo fuente
- se eliminan directorios no necesarios para el navegador
- se parchean algunas comprobaciones de extensiones no disponibles en WASM
- se ejecuta `composer install`
- si existe `package.json`, se ejecuta `npm install --production`
- se genera la imagen VFS en `assets/facturascripts/`
- se actualiza el manifiesto en `assets/manifests/latest.json`

## Documentacion adicional

- [Inicio de la documentacion](docs/index.md)
- [Puesta en marcha](docs/getting-started.md)
- [Modelo inspirado en WordPress Playground](docs/wordpress-playground.md)
- [Referencia de blueprint.json](docs/blueprint-json.md)
- [Guia de desarrollo](docs/development.md)

## Limitaciones conocidas

- La compatibilidad esta enfocada sobre todo a navegadores Chromium.
- El almacenamiento persistente depende de IndexedDB y Service Workers.
- Las descargas remotas de plugins dependen de `outboundHttp.allowedHosts`.
- Si cambias el bundle o el service worker, puede hacer falta un hard refresh o limpiar el scope.

## Licencia

Consulta la licencia del repositorio y las licencias de FacturaScripts y sus dependencias.
