# Ramas SQLite por version publicada

Fecha: 2026-07-31

## Problema

El bundle del deploy (`pages.yml`, con `FS_VERSION` definido) parte de una release oficial
descargada de `facturascripts.com/DownloadBuild/1/<version>` y le aplica el soporte SQLite
como parche, tomado de un commit fijado a mano en `scripts/build-facturascripts-bundle.sh`:

```sh
SQLITE_COMMIT="14f07e6f2d7ebdace161e5383122011a73d6378c"   # "Add SQLite support", 2026-05-20
```

El parche se descarga como `.diff`, se filtra con `awk` a una lista de 5 ficheros, se aplica
con `patch -p1` y ademas se bajan por `curl` los dos ficheros nuevos que el filtro descarta.

Consecuencias:

- Cualquier cambio en la rama `feature/add-sqlite-support` exige editar ese SHA a mano.
- Los arreglos posteriores al pin nunca llegan al deploy.
- La lista del `awk` hay que mantenerla fichero a fichero.
- El resultado del parcheo no se prueba en ningun momento.

## Evidencia recogida

Todas las pruebas se hicieron contra las versiones oficiales vigentes el 2026-07-31:
stable `2026.41` y beta `2026.5`.

| Escenario | Resultado |
| --- | --- |
| Pin actual (control) | aplica limpio |
| Diff acumulado `master...rama`, `git apply` estricto | falla en `Installer.php` y `EditEjercicio.php` |
| Diff acumulado, `patch --fuzz=3`, sin `EditEjercicio.php` | aplica los 7 ficheros |
| Cherry-pick del delta completo (3 bandas) | conflicto solo en `EditEjercicio.php` y `ModelClass.php` |
| Cherry-pick del delta **curado** (3 bandas) | limpio, 7 ficheros, 0 conflictos |

Dos hallazgos determinan el diseno:

1. **El merge a 3 bandas resuelve la deriva de contexto que hace fracasar a `patch`.**
   `Installer.php` fallaba con `git apply` porque master anadio un docblock
   (`be74ea5cf`) que la release no tiene. El cherry-pick lo automerge sin intervencion.
   No hace falta `fuzz`, que no falla sino que acierta mal: coloca el hunk en otro sitio
   y deja el build en verde con el codigo descolocado.

2. **La rama mezcla dos naturalezas distintas.** Habilitar SQLite (7 ficheros) aplica
   limpio sobre cualquier release. Los arreglos a codigo de master aun no publicado
   (por ejemplo `EditEjercicio.php`, que corrige `417597b01`, de 2026-07-30) conflictuan
   siempre, porque parchean codigo que la release todavia no contiene. Mientras el delta
   incluya solo lo primero, el cherry-pick es impecable.

El resultado del cherry-pick curado se verifico con los mismos controles que hace hoy el
build (`use FacturaScripts\Core\Base\DataBase\SqliteEngine;`, `case 'sqlite':`) mas
`php -l` sobre los cuatro ficheros tocados. Todo correcto.

## Diseno

### Arquitectura

En el fork `erseco/facturascripts`:

- `feature/add-sqlite-support` sigue siendo la unica rama de trabajo. No cambia como se usa.
- `sqlite/<version>` son ramas generadas: release oficial mas delta SQLite. Son efimeras
  y se podan cuando ya no se ofrezca esa version.

En el playground, el build pasa a ser `FS_REF_BRANCH=sqlite/$FS_VERSION` y clonar. Esa
ruta ya existe y es la que se usa en local.

### El delta curado

El delta se sintetiza en el momento de generar, no se mantiene como rama aparte. Se define
como el diff `origin/master...feature/add-sqlite-support` del fork, restringido a `Core/`,
menos una **denylist declarada**. Se usa la forma de tres puntos, que parte de la base de
fusion: asi el delta contiene solo el trabajo de la rama y no los cambios que master haya
acumulado por su cuenta.

Denylist inicial:

- `Core/Template/ModelClass.php`: ya se excluye hoy a proposito, porque las releases
  soportadas traen su propia validacion de longitud y el hunk difiere entre canales.
- `Core/Controller/EditEjercicio.php`: arreglo adelantado a su release.

Aplicando esa regla hoy salen estos 7 ficheros, que son los que se validaron. La lista es
el **resultado** de la regla, no una lista que haya que mantener a mano: si manana la rama
toca un fichero nuevo de `Core/`, entra solo.

```
Core/Base/DataBase.php
Core/Base/DataBase/SqliteEngine.php
Core/Base/DataBase/SqliteQueries.php
Core/Controller/Installer.php
Core/Lib/Import/CSVImport.php
Core/Model/AttachedFile.php
Core/View/Installer/Install.html.twig
```

La denylist tiene red de seguridad: si se anade un arreglo adelantado y se olvida
declararlo, el cherry-pick conflictua y el pipeline se pone en rojo. Nunca se publica una
mezcla incorrecta en silencio.

### Workflow de generacion

Programado, en el fork. Al detectar una version oficial nueva:

1. Descarga el zip oficial y lo importa como commit, descartando `vendor/` y
   `node_modules/` (el build los regenera con `composer install` y `npm install`).
   Este paso es necesario porque **no todas las versiones tienen tag**: beta `2026.5`
   corresponde a `v2026.5`, pero stable `2026.41` no existe como tag en upstream.
2. Sintetiza el delta curado y lo aplica con merge a 3 bandas.
3. Si aplica limpio, ejecuta la suite SQLite contra la rama resultante y, si esta verde,
   publica `sqlite/<version>`.
4. Si conflictua, deja el pipeline en rojo y abre una PR para resolverlo a mano.

### Cambios en el playground

`scripts/build-facturascripts-bundle.sh` pierde el bloque completo de
`if [ -n "${FS_VERSION:-}" ]`: el `SQLITE_COMMIT` fijado, la descarga del `.diff`, el
filtro `awk`, el `patch -p1`, los dos `curl` y el borrado de los `.orig`. Son unas 45
lineas.

`scripts/fetch-facturascripts-source.sh` deja de tratar `FS_VERSION` como "descargar zip
oficial" y pasa a resolver la rama `sqlite/$FS_VERSION`.

Hay que revisar que `SOURCE_COMMIT` en el manifest siga siendo correcto: hoy vale
`official-$FS_VERSION` en la ruta del deploy, y con este cambio pasa a haber un commit
real que conviene registrar.

### Verificacion

Es la ganancia principal frente a cualquier variante de parcheo en tiempo de build:
`sqlite/<version>` es una rama de git real, asi que el CI puede correr contra ella la
suite de tests con SQLite antes de publicar el bundle. Hoy el resultado del parcheo no lo
prueba nadie.

## Fuera de alcance

- El orden de comprobaciones en `Where::sqlColumn()` del core (`integer:` y `lower:` se
  evaluan despues del paso directo por parentesis, de modo que `integer:LENGTH(campo)`
  genera SQL invalido). Es un fallo latente, no alcanzable desde entrada de usuario.
- Subir el soporte SQLite a upstream (`NeoRazorX/facturascripts`). Si entrase, todo este
  andamiaje sobraria.

## Riesgos

- **Cadencia de releases**: upstream publica cada ~2 semanas (v2026.1 el 28-04, v2026.2 el
  13-05, v2026.3 el 27-05, v2026.4 el 04-07, v2026.5 el 18-07). Cada una dispara una
  generacion.
- **Conflictos reales**: cuando los haya, el bundle de esa version queda bloqueado hasta
  que se resuelvan a mano. Es el comportamiento buscado, pero conviene tenerlo presente.
- **Importacion del zip**: hay que asegurarse de que el tree importado no arrastra
  `vendor/` ni `node_modules/`, o el bundle crecera y el `composer install` posterior
  podria comportarse de forma distinta.
