import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

import * as vscode from 'vscode';

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
import type { ForkStatusController } from './fork-status-controller';

/**
 * Runs the schema-extractor CLI (issue #22) and holds its result (issue #25).
 *
 * The extractor is a framework-dependent .NET DLL bundled under
 * `assets/schema-cli/`. This controller:
 *   - invokes it as `dotnet <dll> <forkRoot> <cacheDir>` at activation, when the
 *     built DLLs change (debounced — a rebuild rewrites many DLLs in a burst),
 *     and on the `SS14: Rebuild schema` command;
 *   - writes only into `context.globalStorageUri/schema/<fork>-<hash>/`, never
 *     the fork tree;
 *   - never guesses freshness itself — the CLI fingerprints its inputs and
 *     no-ops in tens of milliseconds when nothing changed;
 *   - turns the run into one {@link SchemaStatus} (pure core) and reports every
 *     change of it to the "SS14 Editor" Output channel, like a fork-detection
 *     problem — no status bar, no toast, no modal (issue #45);
 *   - keeps the parsed {@link SchemaRoot} in memory for the provider tickets,
 *     and drops it whenever the status is anything but `loaded` so providers
 *     stay down on an incompatible or failed schema.
 */

const DLL_DEBOUNCE_MS = 600;
const CLI_TIMEOUT_MS = 120_000;

export class SchemaController implements vscode.Disposable {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /** `undefined` until the first status is reported, so that first one is always logged. */
  private status: SchemaStatus | null | undefined = undefined;
  private schemaRoot: SchemaRoot | null = null;

  /** Non-null while an extractor run is in flight; a request during a run re-runs after it. */
  private inFlight: Promise<void> | undefined;
  private rerunQueued = false;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  /**
   * Fires after every schema status change (run finished, or the fork stopped
   * being recognised). The provider tickets subscribe to bring their
   * completion/hover/definition providers up and down with {@link schema}.
   */
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly forkStatus: ForkStatusController,
    private readonly log: vscode.OutputChannel,
  ) {
    const dllWatcher = vscode.workspace.createFileSystemWatcher(
      '**/bin/Content.{Server,Client}/*.dll',
    );
    const bump = () => this.scheduleRun();
    dllWatcher.onDidCreate(bump, undefined, this.disposables);
    dllWatcher.onDidChange(bump, undefined, this.disposables);
    dllWatcher.onDidDelete(bump, undefined, this.disposables);

    this.disposables.push(
      dllWatcher,
      this.changeEmitter,
      this.forkStatus.onDidChange(() => this.onForkStatusChanged()),
    );

    // First extraction at activation — straight through, not via the DLL-burst
    // debounce, so a Reload Window on an unchanged fork settles in well under a
    // second (the CLI no-ops).
    void this.requestRun();
  }

  /**
   * The in-memory schema for the provider tickets. `null` unless the status is
   * `loaded` — an incompatible or failed extraction must not bring providers up.
   */
  get schema(): SchemaRoot | null {
    return this.schemaRoot;
  }

  /** The `SS14: Rebuild schema` command. Bypasses the debounce; the CLI still no-ops if inputs are unchanged. */
  rebuild(): void {
    void this.requestRun();
  }

  private onForkStatusChanged(): void {
    if (!this.forkStatus.recognizedRoot()) {
      // Nothing to extract from. Clear the schema; the fork-detection line in
      // the log already says why.
      this.debounceCancel();
      this.setStatus(null);
      return;
    }
    this.scheduleRun();
  }

  private scheduleRun(): void {
    this.debounceCancel();
    this.debounceTimer = setTimeout(() => void this.requestRun(), DLL_DEBOUNCE_MS);
  }

  private debounceCancel(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  /**
   * Run the extractor once, coalescing overlapping requests: a request that
   * lands while a run is in flight sets a flag and one more run follows.
   */
  private requestRun(): Promise<void> {
    this.debounceCancel();
    if (this.inFlight) {
      this.rerunQueued = true;
      return this.inFlight;
    }
    this.inFlight = this.run().finally(() => {
      this.inFlight = undefined;
      if (this.rerunQueued) {
        this.rerunQueued = false;
        void this.requestRun();
      }
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const root = this.forkStatus.recognizedRoot();
    if (!root) {
      this.setStatus(null);
      return;
    }

    const cacheDir = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      'schema',
      schemaCacheDirName(root.name, root.uri.fsPath),
    );
    await vscode.workspace.fs.createDirectory(cacheDir);

    const dll = vscode.Uri.joinPath(
      this.context.extensionUri,
      'assets',
      'schema-cli',
      'SS14Editor.SchemaCli.dll',
    ).fsPath;

    const run: SchemaRunOutcome = fs.existsSync(dll)
      ? await invokeCli(dll, root.uri.fsPath, cacheDir.fsPath)
      : { kind: 'extractor-missing' };

    const document = await readIfPresent(vscode.Uri.joinPath(cacheDir, 'metadata.json'));
    const parse: SchemaParse | undefined =
      document === undefined ? undefined : parseSchemaDocument(document);
    const sidecar = await readIfPresent(vscode.Uri.joinPath(cacheDir, 'metadata.fingerprint'));

    const status = interpretSchemaResult({
      run,
      parse,
      sidecarFingerprint: sidecar?.trim() || undefined,
      expectedVersion: EXPECTED_SCHEMA_VERSION,
    });

    this.schemaRoot = status.state === 'loaded' && parse?.ok ? parse.root : null;
    this.setStatus(status);
  }

  private setStatus(status: SchemaStatus | null): void {
    for (const line of schemaStatusLog(this.status, status)) this.log.appendLine(line);
    this.status = status;
    if (status === null) this.schemaRoot = null;
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.debounceCancel();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** `dotnet <dll> <forkRoot> <cacheDir>`, mapped to a {@link SchemaRunOutcome}. */
function invokeCli(dll: string, forkRoot: string, cacheDir: string): Promise<SchemaRunOutcome> {
  return new Promise((resolve) => {
    execFile(
      'dotnet',
      [dll, forkRoot, cacheDir],
      { timeout: CLI_TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ kind: 'dotnet-missing' });
          return;
        }
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ kind: 'exited', code, stderr: stderr ?? '' });
      },
    );
  });
}

async function readIfPresent(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}
