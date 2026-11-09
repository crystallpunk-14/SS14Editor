import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { TextDocument } from 'vscode-languageserver-textdocument';

import {
  collectLocRecords,
  LOCALE_ROOTS,
  LocalizationIndex,
  localeIndexBuilding,
  localeIndexFailed,
  localeIndexReady,
  localeIndexStatusLog,
  localeOf,
  type LocaleIndexStatus,
} from '../core';
import type { FromWorker, ToWorker } from '../host/localization-index-worker';
import type { ForkRoot, ForkState } from './fork-state';
import type { Reporter } from './reporter';

/** Saves land in bursts (Save All, a git checkout); batch them into one worker update. */
const UPDATE_DEBOUNCE_MS = 200;
/** Typing in an open `.ftl`: re-read its unsaved text this long after the last keystroke. */
const EDIT_DEBOUNCE_MS = 300;

/**
 * Owns the localization index — the counterpart of the VS Code
 * `LocalizationIndexController`, driving the very same worker bundle
 * (`dist/localization-index-worker.js`):
 *
 *   - built in the worker thread when a fork is recognised, torn down when it goes;
 *   - saved/created/deleted files under the locale roots re-read by the worker, debounced;
 *   - an open `.ftl` reads as typed, closing it goes back to what is on disk;
 *   - a full rebuild only on `ss14editor.rebuildLocalizationIndex`.
 *
 * A failed build is a problem; writes nothing.
 */
export class LocalizationService {
  /** The live index; `ready` is false until the first build lands. */
  readonly index = new LocalizationIndex();

  private worker: Worker | undefined;
  private forkRoot: string | undefined;
  private readonly pendingPaths = new Set<string>();
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly editTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** `undefined` until the first status is reported, so that first one is always logged. */
  private status: LocaleIndexStatus | null | undefined = undefined;
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly fork: ForkState,
    private readonly reporter: Reporter,
    private readonly openDocuments: () => readonly TextDocument[],
  ) {
    fork.onDidChange(() => this.onForkChanged());
    this.onForkChanged();
  }

  /** Fires after the index changes: a full load, a reset, or any file's keys changing. */
  onDidUpdate(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** `ss14editor.rebuildLocalizationIndex`: re-read every `.ftl` file. */
  rebuild(): void {
    const root = this.fork.recognizedRoot();
    if (root) this.start(root);
    else this.reporter.log(['[locale] rebuild skipped: the folder is not a recognised, built SS14 fork']);
  }

  /** Whether an absolute path is a locale root or lies under one. */
  owns(absolute: string): boolean {
    if (this.forkRoot === undefined) return false;
    const relative = path.relative(this.forkRoot, absolute).split(path.sep).join('/');
    return LOCALE_ROOTS.some((root) => relative === root || relative.startsWith(`${root}/`));
  }

  /** Absolute paths of saved, created or deleted files or folders under the locale roots. */
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

  /** An open document changed; only an `.ftl` under a locale root matters here. */
  documentEdited(document: TextDocument): void {
    const rel = this.localeFileOf(document);
    if (rel === undefined || !this.index.ready) return;
    const pending = this.editTimers.get(rel);
    if (pending) clearTimeout(pending);
    this.editTimers.set(
      rel,
      setTimeout(() => {
        this.editTimers.delete(rel);
        if (this.index.updateFile(rel, collectLocRecords(document.getText(), rel))) this.fireUpdate();
      }, EDIT_DEBOUNCE_MS),
    );
  }

  /** Closed, possibly with unsaved edits: what is on disk is the truth again. */
  documentClosed(document: TextDocument): void {
    const rel = this.localeFileOf(document);
    if (rel === undefined) return;
    const pending = this.editTimers.get(rel);
    if (pending) clearTimeout(pending);
    this.editTimers.delete(rel);
    this.queueUpdate([fileURLToPath(document.uri)]);
  }

  private onForkChanged(): void {
    const root = this.fork.recognizedRoot();
    if (!root) {
      this.stop();
      return;
    }
    // Fork detection re-runs on every DLL change; only a different fork restarts the index.
    if (root.path !== this.forkRoot) this.start(root);
  }

  private start(root: ForkRoot): void {
    this.stop();
    this.forkRoot = root.path;

    // The worker bundle sits next to this one in `dist/`.
    const worker = new Worker(path.join(__dirname, 'localization-index-worker.js'));
    this.worker = worker;
    worker.on('message', (message: FromWorker) => {
      if (this.worker === worker) this.onWorkerMessage(message);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      this.reporter.log([`[locale] worker crashed: ${err.stack ?? err.message}`]);
      this.setStatus(localeIndexFailed(err.message));
    });
    worker.on('exit', (code) => {
      // stop() clears `this.worker` before terminating, so this is an unexpected death.
      if (this.worker !== worker) return;
      this.worker = undefined;
      if (this.status?.state !== 'failed') this.setStatus(localeIndexFailed(`the worker exited (code ${code})`));
    });

    this.setStatus(localeIndexBuilding());
    this.send({ type: 'build', forkRoot: root.path });
  }

  /** Tear down the worker; the index goes back to "not ready". */
  private stop(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.pendingPaths.clear();
    for (const timer of this.editTimers.values()) clearTimeout(timer);
    this.editTimers.clear();
    if (this.worker) void this.worker.terminate();
    this.worker = undefined;
    const wasActive = this.forkRoot !== undefined;
    this.forkRoot = undefined;
    if (wasActive) {
      this.index.reset();
      this.setStatus(null);
      this.fireUpdate();
    }
  }

  /** Fork-relative path of an `.ftl` file under a locale root, or `undefined`. */
  private localeFileOf(document: TextDocument): string | undefined {
    if (this.forkRoot === undefined || !document.uri.startsWith('file:') || !document.uri.endsWith('.ftl')) {
      return undefined;
    }
    const rel = path.relative(this.forkRoot, fileURLToPath(document.uri)).split(path.sep).join('/');
    return localeOf(rel) === null ? undefined : rel;
  }

  private send(message: ToWorker): void {
    this.worker?.postMessage(message);
  }

  private onWorkerMessage(message: FromWorker): void {
    switch (message.type) {
      case 'loaded': {
        this.index.replaceAll(message.records);
        // Files already open read as typed, not as on disk.
        for (const document of this.openDocuments()) {
          const rel = this.localeFileOf(document);
          if (rel !== undefined) this.index.updateFile(rel, collectLocRecords(document.getText(), rel));
        }
        const ready = localeIndexReady(this.index.size, message.files, this.index.locales());
        this.reporter.log([`[locale] ${ready.message.replace(/.$/, '')} — indexed in ${message.elapsedMs} ms.`]);
        this.setStatus(ready);
        this.fireUpdate();
        break;
      }
      case 'updated': {
        if (!this.index.ready) break;
        let changed = false;
        for (const file of message.files) {
          // An open file keeps its typed text.
          const open = this.openDocuments().find((document) => this.localeFileOf(document) === file.filePath);
          const records = open ? collectLocRecords(open.getText(), file.filePath) : file.records;
          changed = this.index.updateFile(file.filePath, records) || changed;
        }
        if (changed) this.fireUpdate();
        break;
      }
      case 'failed':
        this.setStatus(localeIndexFailed(message.reason));
        break;
    }
  }

  private fireUpdate(): void {
    for (const listener of this.listeners) listener();
  }

  private setStatus(status: LocaleIndexStatus | null): void {
    this.reporter.log(localeIndexStatusLog(this.status, status));
    this.status = status;
    this.reporter.problem(
      'locale',
      status?.state === 'failed' ? this.reporter.messages.localeIndexFailed(status.message) : null,
    );
  }

  dispose(): void {
    this.stop();
  }
}
