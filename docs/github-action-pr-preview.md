# GitHub Action PR Preview

The [`erseco/action-facturascripts-playground-pr-preview`](https://github.com/erseco/action-facturascripts-playground-pr-preview) action posts or updates a sticky pull-request comment with a live [FacturaScripts Playground](https://erseco.github.io/facturascripts-playground/) preview.

## What it does

When added to a PR workflow, the action:

1. Builds a [`blueprint.json`](blueprint-json.md) from the inputs you provide.
2. Encodes it as base64url and appends it as `?blueprint-data=…` to the playground URL.
3. Uses the PR branch ZIP as `plugins[0]` so the proposed plugin or extension is loaded in a real FacturaScripts instance.
4. Posts or updates a sticky comment on the PR with the preview link.

Use it for repositories that ship a FacturaScripts plugin or extension and want every PR to include a ready-to-open playground preview.

## Required permissions

The calling workflow must grant write access to pull requests:

```yaml
permissions:
  contents: read
  pull-requests: write
```

## Minimum required workflow

```yaml
name: PR Preview

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - name: Add FacturaScripts Playground preview
        uses: erseco/action-facturascripts-playground-pr-preview@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          zip-url: https://github.com/${{ github.repository }}/archive/refs/heads/${{ github.head_ref }}.zip
```

`zip-url` points to the ZIP of the branch under review. The action installs that ZIP as the primary plugin inside the playground.

## Advanced workflow

The action accepts optional inputs that extend the generated blueprint. Every optional input maps directly to a field described in the [`blueprint.json` reference](blueprint-json.md).

```yaml
name: PR Preview

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - name: Add FacturaScripts Playground preview
        uses: erseco/action-facturascripts-playground-pr-preview@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          zip-url: https://github.com/${{ github.repository }}/archive/refs/heads/${{ github.head_ref }}.zip
          title: My Plugin PR Preview
          description: Preview this PR in FacturaScripts Playground

          # extra plugins loaded alongside the PR zip
          extra-plugins: '["CommandPalette","https://facturascripts.com/plugins/mi-plugin-remoto"]'

          # open a specific page after boot
          landing-page: /AdminPlugins

          # enable PHP error display
          debug-enabled: true

          # site identity
          site-title: FacturaScripts Demo
          site-locale: es_ES
          site-timezone: Europe/Madrid

          # admin credentials
          login-username: admin
          login-password: admin

          # seed demo data
          seed-json: >-
            {"customers":[{"codcliente":"CDEMO1","nombre":"Cliente Demo","cifnif":"12345678Z"}],
             "products":[{"referencia":"SKU-DEMO-001","descripcion":"Producto demo","precio":19.95}]}

          # final override merged last into the blueprint
          blueprint-json: >-
            {"siteOptions":{"timezone":"Europe/Madrid"}}
```

## Inputs reference

| Input | Required | Description |
|---|---|---|
| `github-token` | ✅ | GitHub token with `pull-requests: write` permission |
| `zip-url` | ✅ | URL of the plugin ZIP to load (maps to `plugins[0]` in the blueprint) |
| `title` | ❌ | Blueprint `meta.title` |
| `description` | ❌ | Blueprint `meta.description` |
| `author` | ❌ | Blueprint `meta.author` |
| `playground-url` | ❌ | Override the base playground URL |
| `extra-plugins` | ❌ | JSON array of additional plugins (maps to `plugins`) — see [plugins](blueprint-json.md#como-agregar-plugins) |
| `seed-json` | ❌ | JSON object for `seed` (customers, suppliers, products) — see [seed data](blueprint-json.md#como-agregar-datos-demo) |
| `landing-page` | ❌ | Maps to `landingPage` |
| `debug-enabled` | ❌ | Maps to `debug.enabled` (`true`/`false`) |
| `site-title` | ❌ | Maps to `siteOptions.title` |
| `site-locale` | ❌ | Maps to `siteOptions.locale` |
| `site-timezone` | ❌ | Maps to `siteOptions.timezone` |
| `login-username` | ❌ | Maps to `login.username` |
| `login-password` | ❌ | Maps to `login.password` |
| `blueprint-json` | ❌ | JSON object merged last into the blueprint as a final override |

## Outputs

| Output | Description |
|---|---|
| `preview-url` | The full playground preview URL |

## How the blueprint is built

The action generates a [`blueprint.json`](blueprint-json.md) from your inputs, encodes it, and passes it to the playground via `?blueprint-data=`. For example, the minimum inputs produce:

```json
{
  "meta": {
    "title": "PR Preview",
    "author": "erseco",
    "description": "Preview this PR in FacturaScripts Playground"
  },
  "plugins": [
    "https://github.com/OWNER/REPO/archive/refs/heads/BRANCH.zip"
  ]
}
```

When optional inputs are provided they are merged in order, with `blueprint-json` applied last. The resulting URL looks like:

```
https://erseco.github.io/facturascripts-playground/?blueprint-data=ENCODED_BLUEPRINT
```

See [`blueprint.json`](blueprint-json.md) for a full description of every supported field.
