import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import * as vscode from 'vscode';

import {
  EXPECTED_SCHEMA_VERSION,
  indexBuilding,
  indexFailed,
  indexReady,
  indexStatusLog,
  PROTOTYPE_ROOTS,
  PrototypeIndex,
  schemaCacheDirName,
  type IndexStatus,
  type RecordDiff,
} from '../core';
import type { ForkStatusController } from './fork-status-controller';
import type { FromWorker, ToWorker } from './prototype-index-worker';

/** Saves land in bursts (Save All, a git checkout); batch them into one worker update. */
const UPDATE_DEBOUNCE_MS = 200;

/**
 * Everything under the prototype roots, not just `*.yml`: a deleted or renamed
 * folder is reported once, by its own path, and the worker expands it.
 */
const WATCH_GLOB = `{${PROTOTYPE_ROOTS.map((root) => root.dir).join(',')}}/**`;

type ForkRoot = NonNullable<ReturnType<ForkStatusController['recognizedRoot']>>;

/**
 * Owns the prototype index (issue #28): every prototype of every kind in
 * `Resources/Prototypes/**` and the engine's `EnginePrototypes/**`.
 *
 *   - Builds in a worker thread ({@link import('./prototype-index-worker')}) —
 *     a cache hit at activation, a cold parse otherwise — so the Extension Host
 *     stays responsive; the Output channel logs the start, then the count.
 *   - Until the first load, {@link index} answers lookups with "not ready".
 *   - The cache fingerprint takes `EXPECTED_SCHEMA_VERSION`: a loaded schema of
 *     any other version is `incompatible` (issue #25), so the two never differ
 *     while providers are up, and the index need not wait for the CLI.
 *   - On save (and create/delete) of a prototype file, the worker re-parses just
 *     that file and the index is patched in place; {@link onDidUpdate} carries
 *     the per-file diff. There is no "too many files -> full rebuild" threshold.
 *   - A full rebuild happens only on a cold start, an invalid cache, or the
 *     `SS14: Rebuild prototype index` command.
 *   - Writes only the cache under `globalStorageUri/prototype-index/`, never the
 *     fork tree.
 */
export class PrototypeIndexController implements vscode.Disposable {
  /** The live index. `ready` is false until the first build or cache load lands. */
  readonly index = new PrototypeIndex();

  private worker: Worker | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private forkRoot: string | undefined;
  private pendingPaths = new Set<string>();
  private updateTimer: ReturnType<typeof setTimeout> | undefined;

  /** `undefined` until the first status is reported, so that first one is always logged. */
  private status: IndexStatus | null | undefined = undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly updateEmitter = new vscode.EventEmitter<RecordDiff | undefined>();

  /**
   * Fires after the index changes: with the diff of an incremental update, or
   * `undefined` after a full (re)load or a reset.
   */
  readonly onDidUpdate = this.updateEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly forkStatus: ForkStatusController,
    private readonly log: vscode.OutputChannel,
  ) {
    this.disposables.push(
      this.updateEmitter,
      this.forkStatus.onDidChange(() => this.onForkStatusChanged()),
    );
    this.onForkStatusChanged();
  }

  /** The `SS14: Rebuild prototype index` command: a cold parse that ignores the cache. */
  rebuild(): void {
    const root = this.forkStatus.recognizedRoot();
    if (root) this.start(root, true);
    else this.log.appendLine('[index] rebuild skipped: the folder is not a recognised, built SS14 fork');
  }

  private onForkStatusChanged(): void {
    const root = this.forkStatus.recognizedRoot();
    if (!root) {
      this.stop();
      return;
    }
    // Fork-detection re-runs on every DLL change; only a different fork restarts the index.
    if (root.uri.fsPath !== this.forkRoot) this.start(root, false);
  }

  private start(root: ForkRoot, force: boolean): void {
    this.stop();
    this.forkRoot = root.uri.fsPath;

    const cachePath = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      'prototype-index',
      `${schemaCacheDirName(root.name, root.uri.fsPath)}.json`,
    ).fsPath;

    // The worker bundle sits next to this one in `dist/`.
    const worker = new Worker(path.join(__dirname, 'prototype-index-worker.js'));
    this.worker = worker;
    worker.on('message', (message: FromWorker) => {
      if (this.worker === worker) this.onWorkerMessage(message);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      this.log.appendLine(`[index] worker crashed: ${err.stack ?? err.message}`);
      this.setStatus(indexFailed(err.message));
    });
    worker.on('exit', (code) => {
      // stop() clears `this.worker` before terminating, so this is an unexpected death.
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.log.appendLine(`[index] worker exited with code ${code}`);
      if (this.status?.state !== 'failed') this.setStatus(indexFailed(`the worker exited (code ${code})`));
    });

    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root.uri, WATCH_GLOB));
    const queue = (uri: vscode.Uri) => this.queueUpdate(uri.fsPath);
    this.watcher.onDidChange(queue);
    this.watcher.onDidCreate(queue);
    this.watcher.onDidDelete(queue);

    this.setStatus(indexBuilding(0, 0));
    this.send({
      type: 'build',
      forkRoot: root.uri.fsPath,
      cachePath,
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      force,
    });
  }

  /** Tear down the worker and watcher; the index goes back to "not ready". */
  private stop(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.pendingPaths.clear();
    this.watcher?.dispose();
    this.watcher = undefined;
    if (this.worker) void this.worker.terminate();
    this.worker = undefined;
    const wasActive = this.forkRoot !== undefined;
    this.forkRoot = undefined;
    if (wasActive) {
      this.index.reset();
      this.setStatus(null);
      this.updateEmitter.fire(undefined);
    }
  }

  private queueUpdate(fsPath: string): void {
    this.pendingPaths.add(fsPath);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      const paths = [...this.pendingPaths];
      this.pendingPaths.clear();
      this.send({ type: 'update', paths });
    }, UPDATE_DEBOUNCE_MS);
  }

  private send(message: ToWorker): void {
    this.worker?.postMessage(message);
  }

  private onWorkerMessage(message: FromWorker): void {
    switch (message.type) {
      case 'progress':
        this.setStatus(indexBuilding(message.done, message.total));
        break;
      case 'loaded':
        this.index.replaceAll(message.records);
        this.log.appendLine(
          `[index] ${message.records.length} prototypes ${
            message.fromCache ? 'read from cache' : 'parsed'
          } in ${message.elapsedMs} ms` +
            (message.skippedFiles > 0 ? `, ${message.skippedFiles} files skipped` : ''),
        );
        this.setStatus(indexReady(this.index.size, message.skippedFiles));
        this.updateEmitter.fire(undefined);
        break;
      case 'updated': {
        if (!this.index.ready) break;
        for (const file of message.files) {
          const diff = this.index.updateFile(file.filePath, file.records);
          if (diff.added.length + diff.removed.length + diff.changed.length === 0) continue;
          this.log.appendLine(
            `[index] ${file.filePath}: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`,
          );
          this.updateEmitter.fire(diff);
        }
        this.setStatus(indexReady(this.index.size, message.skippedFiles));
        break;
      }
      case 'log':
        this.log.appendLine(`[index] ${message.message}`);
        break;
      case 'failed':
        this.setStatus(indexFailed(message.reason));
        break;
    }
  }

  private setStatus(status: IndexStatus | null): void {
    for (const line of indexStatusLog(this.status, status)) this.log.appendLine(line);
    this.status = status;
  }

  dispose(): void {
    this.stop();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
