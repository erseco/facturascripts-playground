# Modelo inspirado en WordPress Playground

## Que significa aqui

Este proyecto no ejecuta WordPress. Usa el mismo patron general popularizado por WordPress Playground para arrancar una aplicacion PHP completa dentro del navegador. En este caso, la aplicacion es [FacturaScripts](https://facturascripts.com).

## Patrones que se reutilizan

- PHP ejecutado en el navegador con WebAssembly
- service worker para interceptar y enrutar peticiones
- core readonly separado del estado mutable
- configuracion declarativa por blueprint
- arranque idempotente segun el estado persistido

## Flujo real en este repositorio

```text
index.html
  -> src/shell/main.js
     -> remote.html
        -> src/remote/main.js
           -> sw.js
              -> php-worker.js
                 -> src/runtime/bootstrap.js
                 -> src/runtime/vfs.js
                 -> php-cgi-wasm
```

En un arranque limpio, el runtime:

1. carga el manifiesto de `assets/manifests/latest.json`
2. monta el bundle readonly desde `assets/facturascripts/`
3. crea la estructura mutable de `/persist` y `/www/facturascripts`
4. escribe `config.php` y `php.ini`
5. ejecuta `Plugins()->deploy()` para compilar vistas y assets
6. lanza una primera peticion a `/` para la inicializacion de FacturaScripts
7. realiza autologin si `autologin` esta activado

## Diferencias importantes respecto al proyecto heredado

- el payload de este proyecto es FacturaScripts
- el docroot efectivo es `/www/facturascripts`
- el bundle se guarda en `assets/facturascripts/`
- la base de datos es SQLite en `/persist/mutable/db/facturascripts.sqlite`
- el blueprint actual es mucho mas pequeno y esta centrado en login, locale, timezone y landing page

## Restricciones practicas

- el proyecto sigue orientado a navegadores Chromium
- el estado persistido depende de IndexedDB y Service Workers
- los plugins remotos aun no se materializan automaticamente
- cambios en `sw.js` o el bundle pueden requerir hard refresh

## Referencias

- WordPress Playground: <https://wordpress.github.io/wordpress-playground/>
- FacturaScripts: <https://facturascripts.com/>
- Ayuda de FacturaScripts: <https://facturascripts.com/ayuda>
