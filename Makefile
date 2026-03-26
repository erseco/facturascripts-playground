PORT ?= 8085
FS_REF ?= https://github.com/erseco/facturascripts.git
FS_REF_BRANCH ?= feature/add-sqlite-support

.PHONY: help up deps prepare bundle serve test lint format clean reset

help:
	@printf '%s\n' 'FacturaScripts Playground Make targets:' '' '  make deps      Install npm dependencies' '  make prepare   Sync browser deps and prepare runtime assets' '  make bundle    Build the readonly FacturaScripts bundle' '  make serve     Start the local dev server' '  make up        Run bundle + serve' '  make test      Run unit tests' '  make lint      Run Biome linter' '  make format    Auto-fix lint and formatting issues' '  make clean     Remove generated caches and bundle artifacts' '  make reset     Alias of clean plus cache reset' '' 'Common overrides:' '  PORT=9090 make serve' '  FS_REF=<repo> FS_REF_BRANCH=<branch> make bundle'

deps:
	npm install

prepare: deps
	npm run sync-browser-deps
	npm run build-worker
	npm run prepare-runtime

bundle: prepare
	FS_REF=$(FS_REF) FS_REF_BRANCH=$(FS_REF_BRANCH) npm run bundle

test:
	node --test tests/*.test.mjs

lint:
	npx @biomejs/biome check

format:
	npx @biomejs/biome check --fix

serve:
	PORT=$(PORT) node ./scripts/dev-server.mjs

up: bundle serve

clean:
	rm -rf .cache
	rm -rf vendor
	rm -rf dist
	rm -rf assets/facturascripts/*
	rm -rf assets/manifests/*
	touch assets/facturascripts/.gitkeep assets/manifests/.gitkeep

reset: clean
	rm -rf .cache
