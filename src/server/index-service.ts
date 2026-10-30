import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { WorkDoneProgressServerReporter } from 'vscode-languageserver/node';

import {
  EXPECTED_SCHEMA_VERSION,
  indexBuilding,
  indexFailed,
  indexReady,
  indexStatusLog,
  PrototypeIndex,
  schemaCacheDirName,
  type IndexStatus,
} from '../core';
import type { FromWorker, ToWorker } from '../host/prototype-index-worker';
import type { ForkRoot, ForkState } from './fork-state';
import type { Reporter } from './reporter';

/** Saves land in bursts (Save All, a git checkout); batch them into one worker update. */
const UPDATE_DEBOUNCE_MS = 200;

/**
 * Owns the prototype index — the counterpart of the VS Code
 * `PrototypeIndexController`, driving the very same worker bundle
 * (`dist/prototype-index-worker.js`):
 *
 *   - a cache hit at start, a cold parse otherwise, in the worker thread;
 *   - restarted only when the recognised fork root changes, torn down when it goes;
 *   - saved/created/deleted prototype files re-parsed one by one, debounced;
 *   - a full rebuild only on a cold start, a bad cache or `ss14editor.rebuildPrototypeIndex`;
 *   - writes only `<storage>/prototype-index/`, never the fork tree.
 *
 * A build is shown as `$/progress` with the file count; a failure is a problem.
 */
export class IndexService {
  /** The live index; `ready` is false until the first build or cache load lands. */
  readonly index = new PrototypeIndex();

  private worker: Worker | undefined;
  private forkRoot: string | undefined;
  private readonly pendingPaths = new Set<string>();
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  /** `undefined` until the first status is reported, so that first one is always logged. */
  private status: IndexStatus | null | undefined = undefined;
  private progress: Promise<WorkDoneProgressServerReporter> | undefined;

  constructor(
    private readonly fork: ForkState,
    private readonly storagePath: string,
    private readonly reporter: Reporter,
  ) {
    fork.onDidChange(() => this.onForkChanged());
    this.onForkChanged();
  }

  /** `ss14editor.rebuildPrototypeIndex`: a cold parse that ignores the cache. */
  rebuild(): void {
    const root = this.fork.recognizedRoot();
    if (root) this.start(root, true);
    else this.reporter.log(['[index] rebuild skipped: the folder is not a recognised, built SS14 fork']);
  }

  /** Absolute paths of saved, created or deleted files or folders under the prototype roots. */
  queueUpdate(paths: readonly string[]): void {
    if (!this.worker) return;
    for (const p of paths) this.pendingPaths.add(p);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      const batch = [...this.pendingPaths];
      this.pendingPaths.clear();
      this.send({ type: 'update', paths: batch });
    }, UPDATE_DEBOUNCE_MS);
  }

  private onForkChanged(): void {
    const root = this.fork.recognizedRoot();
    if (!root) {
      this.stop();
      return;
    }
    // Fork detection re-runs on every DLL change; only a different fork restarts the index.
    if (root.path !== this.forkRoot) this.start(root, false);
  }

  private start(root: ForkRoot, force: boolean): void {
    this.stop();
    this.forkRoot = root.path;

    const cachePath = path.join(this.storagePath, 'prototype-index', `${schemaCacheDirName(root.name, root.path)}.json`);
    // The worker bundle sits next to this one in `dist/`.
    const worker = new Worker(path.join(__dirname, 'prototype-index-worker.js'));
    this.worker = worker;
    worker.on('message', (message: FromWorker) => {
      if (this.worker === worker) this.onWorkerMessage(message);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      this.reporter.log([`[index] worker crashed: ${err.stack ?? err.message}`]);
      this.setStatus(indexFailed(err.message));
    });
    worker.on('exit', (code) => {
      // stop() clears `this.worker` before terminating, so this is an unexpected death.
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.reporter.log([`[index] worker exited with code ${code}`]);
      if (this.status?.state !== 'failed') this.setStatus(indexFailed(`the worker exited (code ${code})`));
    });

    this.setStatus(indexBuilding(0, 0));
    this.send({ type: 'build', forkRoot: root.path, cachePath, schemaVersion: EXPECTED_SCHEMA_VERSION, force });
  }

  /** Tear down the worker; the index goes back to "not ready". */
  private stop(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.pendingPaths.clear();
    if (this.worker) void this.worker.terminate();
    this.worker = undefined;
    const wasActive = this.forkRoot !== undefined;
    this.forkRoot = undefined;
    if (wasActive) {
      this.index.reset();
      this.setStatus(null);
    }
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
        this.reporter.log([
          `[index] ${message.records.length} prototypes ${message.fromCache ? 'read from cache' : 'parsed'} in ${message.elapsedMs} ms` +
            (message.skippedFiles > 0 ? `, ${message.skippedFiles} files skipped` : ''),
        ]);
        this.setStatus(indexReady(this.index.size, message.skippedFiles));
        break;
      case 'updated': {
        if (!this.index.ready) break;
        for (const file of message.files) {
          const diff = this.index.updateFile(file.filePath, file.records);
          if (diff.added.length + diff.removed.length + diff.changed.length === 0) continue;
          this.reporter.log([
            `[index] ${file.filePath}: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`,
          ]);
        }
        this.setStatus(indexReady(this.index.size, message.skippedFiles));
        break;
      }
      case 'log':
        this.reporter.log([`[index] ${message.message}`]);
        break;
      case 'failed':
        this.setStatus(indexFailed(message.reason));
        break;
    }
  }

  private setStatus(status: IndexStatus | null): void {
    this.reporter.log(indexStatusLog(this.status, status));
    this.status = status;
    this.reporter.problem('index', status?.state === 'failed' ? status.message : null);
    this.showProgress(status);
  }

  /** One `$/progress` per build: begun on `building`, advanced per tick, done on anything else. */
  private showProgress(status: IndexStatus | null): void {
    if (status?.state === 'building') {
      this.progress ??= this.reporter.progress('SS14: indexing prototypes');
      const { done, total } = status;
      if (total > 0) void this.progress.then((p) => p.report(Math.round((done / total) * 100), `${done}/${total} files`));
      return;
    }
    const finished = this.progress;
    this.progress = undefined;
    void finished?.then((p) => p.done());
  }

  dispose(): void {
    this.stop();
  }
}
