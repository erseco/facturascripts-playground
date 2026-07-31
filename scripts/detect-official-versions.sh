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
