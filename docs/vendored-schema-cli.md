# Vendored code: schema-extraction CLI

The C# under [`schema-cli/vendor/`](../schema-cli/vendor/) and the xUnit tests
under [`schema-cli/tests/`](../schema-cli/tests/) are a **vendor copy** taken
from the predecessor editor:

- **Source:** [`TheShuEd/SS14Editor`](https://github.com/TheShuEd/SS14Editor)
- **Commit:** [`7dcf674b4e5d09b0c5a5bd5fbe309b373e6dce50`](https://github.com/TheShuEd/SS14Editor/commit/7dcf674b4e5d09b0c5a5bd5fbe309b373e6dce50)
- **License:** MIT (same as this repo)

Per-file provenance headers are deliberately **not** added; this note is the
single record of origin.

## What was copied

| This repo | Predecessor path | Change |
|---|---|---|
| `schema-cli/vendor/MetadataExtractor.cs`  | `src/Metadata/MetadataExtractor.cs`  | patched — see [Local fixes](#local-fixes) |
| `schema-cli/vendor/FieldExtractor.cs`     | `src/Metadata/FieldExtractor.cs`     | patched — see [Local fixes](#local-fixes) |
| `schema-cli/vendor/CtorDefaultsScanner.cs`| `src/Metadata/CtorDefaultsScanner.cs`| verbatim |
| `schema-cli/vendor/XmlDocReader.cs`       | `src/Metadata/XmlDocReader.cs`       | verbatim |
| `schema-cli/vendor/MetadataModels.cs`     | `src/Metadata/MetadataModels.cs`     | verbatim — the `MetadataRoot` contract |
| `schema-cli/vendor/Logger.cs`             | `src/Core/Logger.cs`                 | verbatim — the only support dependency of the extractors |
| `schema-cli/tests/*.cs`, `schema-cli/tests/Fixtures/*.cs` (plus the tests for the local fixes) | `tests/ss14-editor.Tests/{MetadataExtractor,FieldExtractor,CtorDefaultsScanner,XmlDocReader}Tests.cs`, `TempDir.cs`, `Fixtures/{FixtureTypes,RuntimeHandleStubs}.cs` | verbatim |

The vendored `.cs` files were copied byte-for-byte; the two listed as patched
carry only the [local fixes](#local-fixes) below. Only the project files
(`.csproj`), the `InternalsVisibleTo` shim and the entry point
(`schema-cli/Program.cs`) are new. The spec envisaged a ~30-line entry point;
the actual ~110 lines are that core plus the spec-required `sourceFingerprint`
helper, the unreadable-assembly checks and the argument/error handling.

## What was NOT copied

Explicitly left behind (out of scope for this repo, see issue #22 / spec #20):

- the file-watcher service,
- the HTTP server and `/api/*` models (`ApiModels.cs`, `RedactorContext.cs`,
  `PathSecurity.cs`, `EditorServer`, …),
- all `Services/`,
- the YAML prototype index (rewritten from scratch in TypeScript by later
  tickets),
- the Electron shell and the `WebUI/`.

Their tests (`ApiRouterTests`, `ProtoIndexServiceTests`,
`YamlPrototypeScannerTests`, `FileTreeServiceTests`, `SourceLocatorTests`,
`PathSecurityTests`, …) were not brought over.

## Contract addition

The predecessor's `MetadataRoot` is used **as-is**. `Program.cs` wraps the
extractor's output with two extra root fields before writing it:

- `schemaVersion` (int) — bumped when the emitted document's shape changes,
- `sourceFingerprint` (string) — SHA-256 over `path|size|mtime` of every input
  DLL plus the CLI's own version.

## Local fixes

Bugs in the predecessor's extraction, found by the Rider plan's diagnostics
(stage 4) sweeping a whole fork, fixed here and covered by
`MetadataExtractorTests`. The CLI version moved to 1.0.1 with them, so every
cached schema is re-extracted.

- **`[ComponentProtoName]`** (`MetadataExtractor.InferComponentName`): a
  component is named by that attribute — inherited, as the engine's
  `ComponentFactory` reads it — before falling back to the class name minus
  `Component`. Without it `ContainerContainer`, `BreathMask`,
  `WirelessNetworkConnection` and the like were missing from the schema.
- **Flags on `int` fields** (`FieldExtractor.ApplyCustomSerializer`,
  `MetadataExtractor.DeduplicateEnums`): a `FlagSerializer<TTag>` field takes its
  flags enum as `fullType`, and the enum table never points a field at a value
  list filed under the same key with different values. Before, every such field
  was `System.Int32`, and all of them shared the first one's values
  (`layer:`/`mask:` offered another fork's `ChangeWeaponFireCost`).

