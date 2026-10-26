/**
 * Schema loading — pure core (spec #20, "Схема: контракт, кэш, инвалидация";
 * issue #25). No `vscode`, no host adapter: it turns the raw result of one CLI
 * invocation into a user-facing verdict, and owns the cache-directory naming.
 *
 * The extension always runs the CLI and never second-guesses freshness itself —
 * the CLI fingerprints its inputs and no-ops in tens of milliseconds when
 * nothing changed. After the run the extension checks two things the CLI cannot
 * check for it: that `schemaVersion` is the shape this build expects, and that
 * the `metadata.fingerprint` sidecar matches the document the CLI wrote next to
 * it. Everything else here is message wording.
 */

import { createHash } from 'node:crypto';

import { EXPECTED_SCHEMA_VERSION, type SchemaRoot } from './schema-contract';

export { EXPECTED_SCHEMA_VERSION };

// ---------------------------------------------------------------------------
// Cache directory naming
// ---------------------------------------------------------------------------

/**
 * Name of the per-fork cache folder under `globalStorageUri/schema/`:
 * `<sanitised fork folder name>-<first 8 hex of sha256(fork path)>`.
 *
 * The folder name keeps the directory human-recognisable; the path hash keeps
 * two forks that happen to share a folder name in separate caches (spec #20).
 */
export function schemaCacheDirName(forkFolderName: string, forkPath: string): string {
  const slug =
    forkFolderName
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 40) || 'fork';
  const hash = createHash('sha256').update(forkPath).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

// ---------------------------------------------------------------------------
// Document parsing
// ---------------------------------------------------------------------------

export type SchemaParse =
  | { readonly ok: true; readonly root: SchemaRoot }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps the CLI always emits (mirroring `MetadataRoot`'s `= new()` members). */
const METADATA_MAPS = [
  'prototypes',
  'components',
  'dataDefinitions',
  'polymorphicTypes',
  'enumConstants',
  'enums',
] as const;

/**
 * Parse and shape-check a `metadata.json`. Verifies the two contract roots
 * (`schemaVersion`, `sourceFingerprint`) and that every `MetadataRoot` map is an
 * object; a missing map is defaulted to `{}` so callers can index it freely.
 */
export function parseSchemaDocument(text: string): SchemaParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${(err as Error).message}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, reason: 'the schema document is not a JSON object' };
  }
  if (typeof parsed.schemaVersion !== 'number') {
    return { ok: false, reason: 'missing or non-numeric "schemaVersion"' };
  }
  if (typeof parsed.sourceFingerprint !== 'string') {
    return { ok: false, reason: 'missing or non-string "sourceFingerprint"' };
  }
  for (const key of METADATA_MAPS) {
    if (parsed[key] !== undefined && !isRecord(parsed[key])) {
      return { ok: false, reason: `malformed "${key}" map` };
    }
  }

  const map = <T>(key: (typeof METADATA_MAPS)[number]): Readonly<Record<string, T>> =>
    isRecord(parsed[key]) ? (parsed[key] as Record<string, T>) : {};

  const root: SchemaRoot = {
    schemaVersion: parsed.schemaVersion,
    sourceFingerprint: parsed.sourceFingerprint,
    prototypes: map('prototypes'),
    components: map('components'),
    dataDefinitions: map('dataDefinitions'),
    polymorphicTypes: map('polymorphicTypes'),
    enumConstants: map('enumConstants'),
    enums: map('enums'),
  };
  return { ok: true, root };
}

// ---------------------------------------------------------------------------
// Run result -> verdict
// ---------------------------------------------------------------------------

/** What one attempt to run the extractor CLI produced. */
export type SchemaRunOutcome =
  /** The CLI process ran to completion with this exit code and stderr. */
  | { readonly kind: 'exited'; readonly code: number; readonly stderr: string }
  /** `dotnet` could not be spawned (not on PATH). */
  | { readonly kind: 'dotnet-missing' }
  /** The bundled `SS14Editor.SchemaCli.dll` is not present in this build. */
  | { readonly kind: 'extractor-missing' };

export interface SchemaResultInput {
  readonly run: SchemaRunOutcome;
  /**
   * Parse of `<cacheDir>/metadata.json` as it stands after the run, or
   * `undefined` if that file was absent/unreadable. The host parses once and
   * passes the result here so the (up to ~15 MB) document is not parsed twice.
   */
  readonly parse: SchemaParse | undefined;
  /** Trimmed contents of the `metadata.fingerprint` sidecar, or `undefined` if absent. */
  readonly sidecarFingerprint: string | undefined;
  /** Shape version this build expects (`EXPECTED_SCHEMA_VERSION`). */
  readonly expectedVersion: number;
}

/**
 * The extension's single read of the schema, mirroring {@link
 * import('./fork-detection').ForkStatus}: one `state` discriminant and a
 * `message` on every variant so it can be logged verbatim, in the same
 * unified state as a fork-detection problem (spec #20 — "не тост, не модалка").
 */
export type SchemaStatus =
  | {
      readonly state: 'loaded';
      readonly message: string;
      readonly componentCount: number;
      readonly schemaVersion: number;
      readonly sourceFingerprint: string;
    }
  | { readonly state: 'dotnet-missing'; readonly message: string }
  | { readonly state: 'dotnet-too-old'; readonly message: string }
  | { readonly state: 'extractor-missing'; readonly message: string }
  | { readonly state: 'extraction-failed'; readonly message: string; readonly stderr: string }
  | { readonly state: 'fingerprint-mismatch'; readonly message: string }
  | {
      readonly state: 'incompatible';
      readonly message: string;
      readonly foundVersion: number;
      readonly expectedVersion: number;
    };

const REBUILD_HINT = 'Run "SS14: Rebuild schema" to try again.';

/** dotnet's message when a net8.0 app meets a runtime older than 8. */
const RUNTIME_TOO_OLD = /you must install or update \.net/i;

/** Cap stderr so a runaway dump can't flood the log; keeps line breaks. */
function clip(text: string, max = 800): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function short(fingerprint: string): string {
  return fingerprint.length > 12 ? `${fingerprint.slice(0, 12)}…` : fingerprint;
}

function extractionFailed(message: string, stderr: string): SchemaStatus {
  return { state: 'extraction-failed', message, stderr: stderr.trim() };
}

export function interpretSchemaResult(input: SchemaResultInput): SchemaStatus {
  const { run, expectedVersion } = input;

  if (run.kind === 'dotnet-missing') {
    return {
      state: 'dotnet-missing',
      message:
        'dotnet not found: the .NET SDK is not on PATH. Install it (or open the folder from a shell where `dotnet` resolves), then ' +
        REBUILD_HINT,
    };
  }

  if (run.kind === 'extractor-missing') {
    return {
      state: 'extractor-missing',
      message:
        'The schema extractor is not bundled with this build (assets/schema-cli/SS14Editor.SchemaCli.dll is missing). ' +
        'Rebuild the extension with `npm run build:schema-cli`.',
    };
  }

  const stderr = run.stderr.trim();

  if (run.code !== 0) {
    if (RUNTIME_TOO_OLD.test(stderr)) {
      return {
        state: 'dotnet-too-old',
        message:
          'The installed .NET runtime is too old for the schema extractor (it needs .NET 8 or newer). ' +
          `Install a current .NET SDK, then ${REBUILD_HINT}\n${clip(stderr)}`,
      };
    }
    return extractionFailed(
      stderr
        ? `Schema extraction failed:\n${clip(stderr)}`
        : `Schema extraction failed (exit code ${run.code}). ${REBUILD_HINT}`,
      run.stderr,
    );
  }

  if (input.parse === undefined) {
    return extractionFailed(
      `Schema extraction reported success but wrote no metadata.json. ${REBUILD_HINT}`,
      run.stderr,
    );
  }
  if (!input.parse.ok) {
    return extractionFailed(
      `Schema output could not be read: ${input.parse.reason}. ${REBUILD_HINT}`,
      run.stderr,
    );
  }

  const { root } = input.parse;
  if (root.schemaVersion !== expectedVersion) {
    return {
      state: 'incompatible',
      foundVersion: root.schemaVersion,
      expectedVersion,
      message:
        `Schema is incompatible: the extractor produced version ${root.schemaVersion}, ` +
        `this build expects ${expectedVersion}. Update the extension. Editing help stays off until the versions match.`,
    };
  }

  if (
    input.sidecarFingerprint !== undefined &&
    input.sidecarFingerprint !== root.sourceFingerprint
  ) {
    return {
      state: 'fingerprint-mismatch',
      message:
        `Schema output is inconsistent: the fingerprint the extractor wrote next to metadata.json ` +
        `(${short(input.sidecarFingerprint)}) does not match the document (${short(root.sourceFingerprint)}). ` +
        REBUILD_HINT,
    };
  }

  const componentCount = Object.keys(root.components).length;
  return {
    state: 'loaded',
    componentCount,
    schemaVersion: root.schemaVersion,
    sourceFingerprint: root.sourceFingerprint,
    message: `Schema loaded from the fork build: ${componentCount} components.`,
  };
}
