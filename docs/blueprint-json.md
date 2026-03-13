# `blueprint.json`

## Que es

En este repositorio, `blueprint.json` es la descripcion portable de la configuracion inicial que debe aplicar FacturaScripts Playground dentro de un scope del navegador.

El archivo por defecto es:

`assets/blueprints/default.blueprint.json`

La implementacion real esta en:

- esquema: `assets/blueprints/blueprint-schema.json`
- normalizacion: `src/shared/blueprint.js`

## Que aplica hoy el runtime

Actualmente el runtime usa el blueprint para:

- elegir la ruta inicial con `landingPage`
- activar o no el modo debug con `debug.enabled`
- fijar `title`, `locale` y `timezone` efectivos
- sobreescribir el usuario y password del login inicial

El array `plugins` ya se valida y normaliza, pero todavia no ejecuta instalacion automatica en el arranque.

## Estructura soportada

| Propiedad | Uso | Notas |
| --- | --- | --- |
| `$schema` | Referencia de schema | Opcional pero recomendable |
| `meta` | Metadatos descriptivos | `title`, `author`, `description` |
| `debug.enabled` | Errores PHP visibles | Util para diagnostico |
| `landingPage` | Ruta de entrada | Se normaliza para empezar por `/` |
| `siteOptions` | Ajustes de la instancia | `title`, `locale`, `timezone` |
| `login` | Credenciales efectivas | `username`, `password` |
| `plugins` | Declaracion de plugins | Sin materializacion automatica todavia |

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
    {
      "name": "OtroPlugin",
      "source": {
        "type": "url",
        "url": "https://example.com/OtroPlugin.zip"
      }
    }
  ]
}
```

## Como cargarlo

Puedes aportar un blueprint de tres formas:

- `?blueprint=/ruta/al/archivo.json`
- `?blueprint-data=...` con JSON codificado en base64url
- importando el JSON desde la shell

## Reglas y convenciones del proyecto

- `landingPage` siempre se normaliza a una ruta absoluta interna.
- `login.username` y `login.password` sobreescriben el admin del runtime.
- `plugins` no admite nombres duplicados.
- los nombres de plugin deben ser un unico segmento de ruta
- `plugins[].source.type` soporta `bundled` y `url`
- las URLs de plugins se absolutizan contra la URL actual

## Que no hace todavia

El runtime actual no descarga ni instala plugins remotos a partir de `plugins`. Esa parte esta pendiente en `src/runtime/addons.js`.

Por tanto, usa `plugins` hoy como:

- configuracion declarativa prevista
- metadato util para futuras integraciones
- reflejo de plugins que ya vengan empaquetados en el bundle

## Como validar cambios

1. edita el JSON
2. comprueba que sigue el schema de `assets/blueprints/blueprint-schema.json`
3. importa el blueprint o arranca con un scope limpio
4. verifica login, locale, timezone, titulo y landing page
5. si algo falla, activa `debug.enabled`

Checks utiles:

```bash
node --check src/shared/blueprint.js
node --check src/runtime/bootstrap.js
```
