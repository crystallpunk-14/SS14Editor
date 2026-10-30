import * as path from 'node:path';

import { detectFork, forkStatusLog, type ForkFolderStatus } from '../core';
import { createForkFs } from '../host/fork-fs';
import type { Reporter } from './reporter';

const REFRESH_DEBOUNCE_MS = 300;

/** The fork the server works on, when it is a recognised one. */
export interface ForkRoot {
  readonly name: string;
  readonly path: string;
}

/**
 * The fork-detection verdict for the server's root (the counterpart of the VS
 * Code `ForkStatusController`): detected at start and again, debounced, when the
 * built DLLs change, so a "build is stale" warning clears after a rebuild.
 * Every change is logged; a blocking or stale verdict is surfaced as a problem.
 */
export class ForkState {
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** `undefined` until the first detection, so that first verdict is always logged. */
  private current: ForkFolderStatus | null | undefined = undefined;
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly rootPath: string | undefined,
    private readonly reporter: Reporter,
  ) {
    this.detect();
  }

  /** The root when — and only when — it is a recognised fork (a stale build counts). */
  recognizedRoot(): ForkRoot | undefined {
    return this.current?.status.recognized && this.rootPath
      ? { name: this.current.name, path: this.rootPath }
      : undefined;
  }

  /** True while the recognised fork's C# sources are newer than its built DLLs. */
  isStale(): boolean {
    return !!(this.current?.status.recognized && this.current.status.stale);
  }

  onDidChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** A DLL under `bin/Content.*` changed: re-detect once the rebuild's burst settles. */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.detect();
      for (const listener of this.listeners) listener();
    }, REFRESH_DEBOUNCE_MS);
  }

  private detect(): void {
    const previous = this.current;
    const next = this.rootPath
      ? { name: path.basename(this.rootPath), status: detectFork(createForkFs(this.rootPath)) }
      : null;
    this.reporter.log(forkStatusLog(previous, next));
    this.current = next;

    const status = next?.status;
    if (!status) this.reporter.problem('fork', 'no folder is open — open an SS14 fork.', 'warning');
    else if (!status.recognized) this.reporter.problem('fork', status.message, 'warning');
    else if (status.stale) this.reporter.problem('fork', status.stale.message, 'warning');
    else this.reporter.problem('fork', null);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }
}
