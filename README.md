# SS14 Prototype Editor

VS Code extension for editing SS14 (RobustToolbox) YAML prototypes with schema
awareness. The extension lives at the repo root; see `CONTEXT.md` and `docs/`
for the domain model and design decisions, and issue
[#20](https://github.com/crystallpunk-14/SS14Editor/issues/20) for the v1 spec.

## Status

Issues [#21](https://github.com/crystallpunk-14/SS14Editor/issues/21) (skeleton),
[#23](https://github.com/crystallpunk-14/SS14Editor/issues/23) (fork detection)
and [#25](https://github.com/crystallpunk-14/SS14Editor/issues/25) (schema
connection): the extension runs fork detection on the workspace root and reports
to the **SS14 Editor** Output channel either the single concrete reason the
folder is not a built fork (no `RobustToolbox` submodule, no `Content.Server` /
`Content.Client` / `Resources/Prototypes`, no DLLs in `bin/Content.*`, or a stale
build) or, once it is, the schema and prototype-index verdicts. The Output
channel is the only status surface: no sidebar view, status-bar item or toast
(issue [#45](https://github.com/crystallpunk-14/SS14Editor/issues/45) dropped the
inspector sidebar from v1).

On a recognised fork the host runs the bundled schema extractor
(`dotnet assets/schema-cli/SS14Editor.SchemaCli.dll <forkRoot> <cacheDir>`),
caching its `metadata.json` under
`globalStorageUri/schema/<fork>-<hash>/` — never in the fork tree. It re-runs on
activation, on a debounced change to `bin/Content.{Server,Client}/*.dll`, and on
the **SS14: Rebuild schema** command; the CLI fingerprints its inputs and no-ops
when nothing changed. The parsed schema stays in memory for the provider tickets;
a `schemaVersion` the extension does not expect is reported as incompatible and
keeps providers down. Completion, hover and go-to-definition in prototype YAML are
the extension's only editing surface.

## Layout

| Path          | Layer                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| `src/core/`   | Pure TypeScript. **No `vscode` import** — the single test seam (lint-enforced). Fork detection, YAML core, and the schema contract + `interpretSchemaResult` verdict live here. |
| `src/host/`   | Thin VS Code adapter: activation, provider registration, the real-FS `ForkFs`, running the schema CLI (`schema-controller.ts`), the prototype-index worker, status logging. |
| `assets/`     | Build output shipped in the `.vsix` — the published schema extractor (`assets/schema-cli/`). Git-ignored; produced by `npm run build:schema-cli`. |

`esbuild.mjs` produces three independent bundles: `dist/extension.js` (host,
CommonJS), `dist/prototype-index-worker.js` (the index worker thread, CommonJS),
and `out/test/smoke/` (the activation test).

## Commands

```sh
npm install
npm run typecheck        # tsc --noEmit
npm run lint             # eslint (incl. the core/vscode import boundary)
npm run test:core        # vitest — fast, no VS Code
npm run test:smoke       # @vscode/test-electron activation smoke test
npm run build            # esbuild: host + worker + smoke bundles
npm run build:schema-cli # dotnet publish the extractor into assets/schema-cli/
npm run package          # build + build:schema-cli + vsce package -> ss14editor.vsix
```

## Schema extractor

The v1 spec pairs this extension with the vendored C# CLI in
[`schema-cli/`](schema-cli/) that extracts the schema from a fork's
compiled DLLs (issue #22). CI (`.github/workflows/ci.yml`) runs
`dotnet publish -c Release` into `assets/schema-cli/` before the bundle
step, so the `.vsix` carries it. For a local F5 run against a real fork, run
`npm run build:schema-cli` once first — without it the Output channel reports
the extractor as not bundled.
