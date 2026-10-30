import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  EXPECTED_SCHEMA_VERSION,
  interpretSchemaResult,
  parseSchemaDocument,
  schemaCacheDirName,
  schemaStatusLog,
  type SchemaParse,
  type SchemaRoot,
  type SchemaRunOutcome,
  type SchemaStatus,
} from '../core';
import type { ForkState } from './fork-state';
import type { Reporter } from './reporter';

const DLL_DEBOUNCE_MS = 600;
const CLI_TIMEOUT_MS = 120_000;

/**
 * Runs the schema-extractor CLI and holds its result — the counterpart of the VS
 * Code `SchemaController`, with the same rules:
 *
 *   - `dotnet <dll> <forkRoot> <cacheDir>` at start, when the built DLLs change
 *     (debounced: a rebuild rewrites many in a burst) and on `ss14editor.rebuildSchema`;
 *     overlapping requests coalesce into one more run;
 *   - writes only `<storage>/schema/<fork>-<hash>/`, never the fork tree;
 *   - the CLI fingerprints its inputs and no-ops when nothing changed;
 *   - the parsed {@link SchemaRoot} is kept only while the status is `loaded`.
 *
 * A first extraction is announced and shown as progress; any status but
 * `loaded` is surfaced as a problem.
 */
export class SchemaService {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** `undefined` until the first status is reported, so that first one is always logged. */
  private status: SchemaStatus | null | undefined = undefined;
  private schemaRoot: SchemaRoot | null = null;
  private inFlight: Promise<void> | undefined;
  private rerunQueued = false;
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly fork: ForkState,
    private readonly storagePath: string,
    private readonly cliPath: string,
    private readonly reporter: Reporter,
  ) {
    fork.onDidChange(() => this.onForkChanged());
  }

  /** `null` unless the status is `loaded`: an incompatible or failed schema keeps features down. */
  get schema(): SchemaRoot | null {
    return this.schemaRoot;
  }

  /** Fires after every status change (a run finished, or the fork stopped being recognised). */
  onDidChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** First extraction and the rebuild command: straight through, not via the DLL debounce. */
  run(): Promise<void> {
    return this.requestRun();
  }

  /** A built DLL changed. */
  scheduleRun(): void {
    this.debounceCancel();
    this.debounceTimer = setTimeout(() => void this.requestRun(), DLL_DEBOUNCE_MS);
  }

  private onForkChanged(): void {
    if (!this.fork.recognizedRoot()) {
      this.debounceCancel();
      this.setStatus(null);
      return;
    }
    this.scheduleRun();
  }

  private debounceCancel(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private requestRun(): Promise<void> {
    this.debounceCancel();
    if (this.inFlight) {
      this.rerunQueued = true;
      return this.inFlight;
    }
    this.inFlight = this.extract().finally(() => {
      this.inFlight = undefined;
      if (this.rerunQueued) {
        this.rerunQueued = false;
        void this.requestRun();
      }
    });
    return this.inFlight;
  }

  private async extract(): Promise<void> {
    const root = this.fork.recognizedRoot();
    if (!root) {
      this.setStatus(null);
      return;
    }
    // Only a first extraction is worth announcing: re-runs after DLL changes
    // usually no-op in tens of milliseconds.
    const first = this.status == null;
    if (first) this.reporter.log(['[schema] Extracting schema from the fork build…']);
    const progress = first ? await this.reporter.progress('SS14: extracting schema') : undefined;

    try {
      const cacheDir = path.join(this.storagePath, 'schema', schemaCacheDirName(root.name, root.path));
      fs.mkdirSync(cacheDir, { recursive: true });

      const run: SchemaRunOutcome = fs.existsSync(this.cliPath)
        ? await invokeCli(this.cliPath, root.path, cacheDir)
        : { kind: 'extractor-missing' };

      const document = readIfPresent(path.join(cacheDir, 'metadata.json'));
      const parse: SchemaParse | undefined = document === undefined ? undefined : parseSchemaDocument(document);
      const sidecar = readIfPresent(path.join(cacheDir, 'metadata.fingerprint'));

      const status = interpretSchemaResult({
        run,
        parse,
        sidecarFingerprint: sidecar?.trim() || undefined,
        expectedVersion: EXPECTED_SCHEMA_VERSION,
      });
      this.schemaRoot = status.state === 'loaded' && parse?.ok ? parse.root : null;
      this.setStatus(status);
    } finally {
      progress?.done();
    }
  }

  private setStatus(status: SchemaStatus | null): void {
    this.reporter.log(schemaStatusLog(this.status, status));
    this.status = status;
    if (status === null) this.schemaRoot = null;
    this.reporter.problem('schema', status && status.state !== 'loaded' ? status.message : null);
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.debounceCancel();
  }
}

function invokeCli(dll: string, forkRoot: string, cacheDir: string): Promise<SchemaRunOutcome> {
  return new Promise((resolve) => {
    execFile('dotnet', [dll, forkRoot, cacheDir], { timeout: CLI_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ kind: 'dotnet-missing' });
        return;
      }
      const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ kind: 'exited', code, stderr: stderr ?? '' });
    });
  });
}

function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
