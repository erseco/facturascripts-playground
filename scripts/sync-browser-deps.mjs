#!/usr/bin/env node
// Browser runtime dependencies are no longer vendored into vendor/: zstddec is
// bundled into the PHP worker by esbuild, and the FacturaScripts core ships as a
// downloaded tar.zst bundle. This hook is kept (wired into `make prepare`) so a
// future browser dependency can be vendored here without re-adding the step.
console.log("No browser dependencies to vendor.");
