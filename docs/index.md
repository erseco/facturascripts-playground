# FacturaScripts Playground

FacturaScripts Playground ejecuta [FacturaScripts](https://facturascripts.com) completamente en el navegador con WebAssembly. La idea arquitectonica viene de [WordPress Playground](https://wordpress.github.io/wordpress-playground/), pero el runtime, la configuracion y el proceso de arranque de este repositorio estan adaptados a FacturaScripts.

![Captura de FacturaScripts Playground](https://raw.githubusercontent.com/erseco/facturascripts-playground/main/.github/screenshot.png)

<p align="center">
  <a href="https://erseco.github.io/facturascripts-playground/">
    <img src="https://raw.githubusercontent.com/erseco/facturascripts-playground/main/ogimage.png" alt="Probar FacturaScripts en vivo" width="400">
  </a>
  <br>
  <a href="https://erseco.github.io/facturascripts-playground/"><strong>Probar FacturaScripts en vivo</strong></a>
</p>

Usa esta documentacion para:

- entender como se monta el runtime en el navegador
- configurar el playground desde `playground.config.json`
- ajustar el `blueprint.json` por defecto
- reconstruir el bundle readonly de FacturaScripts

## Empieza aqui

- [Getting started](getting-started.md)
- [Modelo inspirado en WordPress Playground](wordpress-playground.md)
- [Referencia de blueprint.json](blueprint-json.md)
- [GitHub Action PR Preview](github-action-pr-preview.md)
- [Development](development.md)

## Que hace este proyecto

El proyecto tiene cinco capas:

1. **Shell UI** en `index.html` y `src/shell/main.js`
2. **Runtime host** en `remote.html` y `src/remote/main.js`
3. **Routing** en `sw.js` y `php-worker.js`
4. **Bootstrap de FacturaScripts** en `src/runtime/*`
5. **Servidor local de desarrollo** en `scripts/dev-server.mjs`

En ejecucion:

- el core readonly se monta desde `assets/facturascripts/`
- el estado mutable se guarda en `/persist`
- la shell embebe FacturaScripts en un `iframe`
- el service worker reescribe rutas para que funcione tanto en raiz como en subdirectorios

## Configuracion

Las dos piezas principales son:

- `playground.config.json`: configuracion global del runtime, usuario admin, locale, timezone y runtimes PHP
- `assets/blueprints/default.blueprint.json`: configuracion funcional de la instancia que se carga por defecto

## Enlaces utiles

- FacturaScripts: <https://facturascripts.com/>
- Ayuda oficial: <https://facturascripts.com/ayuda>
- Codigo fuente oficial: <https://github.com/NeoRazorX/facturascripts>
