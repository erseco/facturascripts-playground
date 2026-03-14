# `blueprint.json`

## Que es

En este repositorio, `blueprint.json` es la descripcion portable de la configuracion inicial que debe aplicar FacturaScripts Playground dentro de un scope del navegador.

El archivo por defecto es:

`assets/blueprints/default.blueprint.json`

Ejemplo completo del repositorio:

`blueprint-sample.json`

La implementacion real esta en:

- esquema: `assets/blueprints/blueprint-schema.json`
- normalizacion: `src/shared/blueprint.js`

## Que aplica hoy el runtime

Actualmente el runtime usa el blueprint para:

- elegir la ruta inicial con `landingPage`
- activar o no el modo debug con `debug.enabled`
- fijar `title`, `locale` y `timezone` efectivos
- sobreescribir el usuario y password del login inicial
- instalar y activar plugins declarados en `plugins`
- sembrar clientes, proveedores y productos declarados en `seed`
- inicializar datos base (impuestos, formas de pago, empresa, almacen, plan contable) segun `install`

## Estructura soportada

| Propiedad | Uso | Notas |
| --- | --- | --- |
| `$schema` | Referencia de schema | Opcional pero recomendable |
| `meta` | Metadatos descriptivos | `title`, `author`, `description` |
| `debug.enabled` | Errores PHP visibles | Util para diagnostico |
| `landingPage` | Ruta de entrada | Se normaliza para empezar por `/` |
| `siteOptions` | Ajustes de la instancia | `title`, `locale`, `timezone` |
| `login` | Credenciales efectivas | `username`, `password` |
| `plugins` | Declaracion de plugins | Cada entrada puede ser nombre de plugin o URL a ZIP |
| `seed` | Datos demo idempotentes | MVP: `customers`, `suppliers`, `products` |
| `install` | Datos base de inicializacion | Empresa, impuestos, plan contable, etc. |

## Ejemplo valido

```json
{
  "$schema": "./assets/blueprints/blueprint-schema.json",
  "meta": {
    "title": "Demo FacturaScripts",
    "author": "equipo-dev",
    "description": "Configuracion base para pruebas locales."
  },
  "debug": {
    "enabled": true
  },
  "landingPage": "/",
  "siteOptions": {
    "title": "FacturaScripts Demo",
    "locale": "es_ES",
    "timezone": "Europe/Madrid"
  },
  "login": {
    "username": "admin",
    "password": "admin"
  },
  "plugins": [
    "MiPlugin",
    "https://facturascripts.com/DownloadBuild/440/stable"
  ],
  "seed": {
    "customers": [
      {
        "codcliente": "CDEMO1",
        "nombre": "Cliente Demo",
        "cifnif": "12345678Z",
        "email": "cliente@example.com"
      }
    ],
    "suppliers": [
      {
        "codproveedor": "PDEMO1",
        "nombre": "Proveedor Demo",
        "cifnif": "B12345678"
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

## Como cargarlo

Puedes aportar un blueprint de tres formas:

- `?blueprint=/ruta/al/archivo.json`
- `?blueprint-data=...` con JSON codificado en base64url
- importando el JSON desde la shell

## Como agregar plugins

Hay dos formas soportadas en el MVP:

### 1. Plugin ya presente en el runtime

Si el plugin ya existe en la carpeta `Plugins` del runtime, basta con indicar su nombre:

```json
{
  "plugins": [
    "MiPlugin"
  ]
}
```

En este caso el playground intentara activarlo durante el arranque.

### 2. Plugin remoto por URL

Si quieres descargar e instalar un plugin remoto, indica la URL directa al ZIP o al `DownloadBuild`:

```json
{
  "plugins": [
    "https://facturascripts.com/plugins/commandpalette"
  ]
}
```

Si la URL apunta a una ficha de plugin de FacturaScripts, el playground resuelve automaticamente el enlace `DownloadBuild` y descarga el ZIP correspondiente.

Esto es lo que usa el ejemplo [blueprint-sample.json](/Users/ernesto/Dropbox/Trabajo/git/facturascripts/facturascripts-playground/blueprint-sample.json) para instalar CommandPalette.

Consejos practicos:

- usa una URL directa al artefacto descargable, no la ficha HTML del plugin
- si estas en local, la descarga pasa por `/__addon_proxy__`
- si el host remoto no esta en `outboundHttp.allowedHosts`, la instalacion fallara con un error claro

### 3. Plugin desde GitHub para probar ramas o PRs

Tambien puedes usar URLs de GitHub y el playground las convertira a un ZIP descargable:

```json
{
  "plugins": [
    "https://github.com/<owner>/<repo>/tree/<branch>",
    "https://github.com/<owner>/<repo>/pull/123"
  ]
}
```

Reglas soportadas:

- `.../tree/<branch>` -> descarga el ZIP de esa rama
- `.../pull/<numero>` -> descarga el ZIP de la cabeza del PR
- `.../archive/...` y `.../releases/download/...` -> se usan tal cual

## Como agregar datos demo

La seccion `seed` permite crear o actualizar datos basicos del entorno demo:

- `customers`
- `suppliers`
- `products`

El comportamiento es idempotente:

- si el registro no existe, se crea
- si ya existe con la misma clave natural, se actualiza
- al recargar el scope no se duplican registros

### Clientes

La clave obligatoria es `codcliente`:

```json
{
  "seed": {
    "customers": [
      {
        "codcliente": "CDEMO1",
        "nombre": "Cliente Demo",
        "cifnif": "12345678Z",
        "email": "cliente@example.com",
        "telefono1": "+34910000001",
        "direccion": "Calle Demo 1",
        "ciudad": "Madrid",
        "provincia": "Madrid",
        "codpais": "ESP"
      }
    ]
  }
}
```

### Proveedores

La clave obligatoria es `codproveedor`:

```json
{
  "seed": {
    "suppliers": [
      {
        "codproveedor": "PDEMO1",
        "nombre": "Proveedor Demo",
        "cifnif": "B12345678",
        "email": "proveedor@example.com"
      }
    ]
  }
}
```

### Productos

La clave obligatoria es `referencia`:

```json
{
  "seed": {
    "products": [
      {
        "referencia": "SKU-DEMO-001",
        "descripcion": "Producto demo",
        "precio": 19.95,
        "stockfis": 25
      }
    ]
  }
}
```

### Ejemplo combinado

```json
{
  "plugins": [
    "https://facturascripts.com/plugins/commandpalette"
  ],
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

Campos recomendados:

- clientes y proveedores: `nombre`, `cifnif`, `email`, `telefono1`, `direccion`, `ciudad`, `provincia`, `codpais`
- productos: `descripcion`, `precio`, `stockfis`, `codfamilia`, `codimpuesto`

## Reglas y convenciones del proyecto

- `landingPage` siempre se normaliza a una ruta absoluta interna.
- `login.username` y `login.password` sobreescriben el admin del runtime.
- `plugins` no admite duplicados.
- si un plugin es un nombre, debe ser un unico segmento de ruta.
- si un plugin es una URL `http` o `https`, se descarga como ZIP y se intenta activar.
- los plugins por nombre solo cubren plugins ya presentes en el runtime.
- `seed.customers[].codcliente`, `seed.suppliers[].codproveedor` y `seed.products[].referencia` son obligatorios.
- el seed hace upsert por esas claves naturales para no duplicar datos en recargas.
- las URLs de plugins remotos estan sujetas a la politica `outboundHttp` del playground.
- en desarrollo local las descargas pasan por `/__addon_proxy__`; en despliegue estatico usan el proxy configurado.

## Seccion `install`

La seccion `install` permite configurar los datos base que normalmente crea el Wizard de FacturaScripts: impuestos, formas de pago, estados de documento, series, diarios, retenciones, provincias, datos de empresa, almacen y plan contable.

El playground ejecuta automaticamente esta inicializacion durante el arranque, despues del primer deploy. Es idempotente: si los impuestos ya existen, no se vuelve a ejecutar.

### Propiedades

| Propiedad | Tipo | Default | Descripcion |
| --- | --- | --- | --- |
| `codpais` | string | `"ESP"` | Codigo de pais (carga defaults de `Data/Codpais/{codpais}/`) |
| `empresa` | string | `"Empresa Playground"` | Nombre de la empresa |
| `cifnif` | string | `"00000014Z"` | CIF/NIF de la empresa |
| `tipoidfiscal` | string | `""` | Tipo de identificacion fiscal |
| `direccion` | string | `""` | Direccion de la empresa |
| `codpostal` | string | `""` | Codigo postal |
| `ciudad` | string | `""` | Ciudad |
| `provincia` | string | `""` | Provincia |
| `regimeniva` | string | `"General"` | Regimen de IVA de la empresa |
| `codimpuesto` | string | `""` | Impuesto por defecto (si vacio, usa el default del pais) |
| `defaultplan` | boolean | `true` | Importar plan contable por defecto del pais |
| `costpricepolicy` | string | `""` | Politica de precio de coste |
| `ventasinstock` | boolean | `false` | Permitir ventas sin stock |
| `updatesupplierprices` | boolean | `true` | Actualizar precios de proveedor automaticamente |

### Ejemplo

```json
{
  "install": {
    "codpais": "ESP",
    "empresa": "Mi Empresa Demo",
    "cifnif": "B12345678",
    "ciudad": "Madrid",
    "provincia": "Madrid",
    "regimeniva": "General",
    "defaultplan": true
  }
}
```

### Que inicializa

1. Carga defaults del pais (`coddivisa`, `codimpuesto`, `codpago`, `codserie`, `tipoidfiscal`)
2. Crea registros base: impuestos, formas de pago, estados de documento, series, diarios, retenciones, provincias
3. Actualiza datos de empresa (nombre, CIF, direccion, pais)
4. Crea/actualiza almacen y lo vincula a la empresa
5. Configura regimen de IVA
6. Importa plan contable (si `defaultplan: true`)
7. Carga todos los modelos dinamicos para crear tablas restantes
8. Ejecuta deploy final de plugins
9. Configura homepage del usuario a Dashboard

## Limitaciones del MVP

- El seed todavia no crea facturas, impuestos, series, almacenes ni stock avanzado.
- Los plugins por URL dependen de `outboundHttp.allowedHosts`.
- La activacion usa las APIs internas de FacturaScripts y puede fallar si el plugin tiene dependencias no satisfechas.
- El blueprint no instala automaticamente plugins de marketplace a partir de un slug suelto; para descargas remotas usa una URL directa al ZIP o la URL de la ficha publica del plugin en FacturaScripts.

## Como validar cambios

1. edita el JSON
2. comprueba que sigue el schema de `assets/blueprints/blueprint-schema.json`
3. importa el blueprint o arranca con un scope limpio
4. verifica login, locale, timezone, titulo, plugins y seed
5. si algo falla, activa `debug.enabled`

Checks utiles:

```bash
node --check src/shared/blueprint.js
node --check src/runtime/bootstrap.js
node --check src/runtime/addons.js
```
