import * as vscode from 'vscode';

import { detectFork, forkStatusLog, type ForkFolderStatus } from '../core';
import { createForkFs } from './fork-fs';

const REFRESH_DEBOUNCE_MS = 300;

/**
 * Owns the fork-detection verdict (issue #23) and reports every change of it to
 * the "SS14 Editor" Output channel with the concrete reason (issue #45).
 *
 * It re-runs detection when the workspace folders change or the built DLLs
 * change on disk, so a "build is stale" warning clears after a rebuild without a
 * window reload (spec #20, "Инвалидация").
 *
 * Issue #25 makes the verdict observable: {@link onDidChange} fires on every
 * re-detection and {@link folder} exposes the current read, so the schema
 * controller can (re)run the extractor exactly when the fork becomes — or stops
 * being — a recognised, freshly-built fork.
 */
export class ForkStatusController implements vscode.Disposable {
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** `undefined` until the first detection, so that first verdict is always logged. */
  private currentFolder: ForkFolderStatus | null | undefined = undefined;
  private currentFolderUri: vscode.Uri | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<ForkFolderStatus | null>();

  /** Fires after every re-detection with the fresh verdict (or `null` if no local folder). */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly log: vscode.OutputChannel) {
    const dllWatcher = vscode.workspace.createFileSystemWatcher(
      '**/bin/Content.{Server,Client}/*.dll',
    );
    const bump = () => this.scheduleRefresh();
    dllWatcher.onDidCreate(bump, undefined, this.disposables);
    dllWatcher.onDidChange(bump, undefined, this.disposables);
    dllWatcher.onDidDelete(bump, undefined, this.disposables);

    this.disposables.push(
      dllWatcher,
      this.changeEmitter,
      vscode.workspace.onDidChangeWorkspaceFolders(bump),
    );

    this.detect();
  }

  /**
   * The workspace-folder root when — and only when — the current verdict is a
   * recognised fork. A stale build counts: its DLLs are the last good build,
   * and the schema and index keep working off them. Bundles the name and URI the schema
   * controller needs so callers never re-check `.recognized` themselves.
   */
  recognizedRoot(): { readonly name: string; readonly uri: vscode.Uri } | undefined {
    if (this.currentFolder?.status.recognized && this.currentFolderUri) {
      return { name: this.currentFolder.name, uri: this.currentFolderUri };
    }
    return undefined;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  private refresh(): void {
    this.detect();
    this.changeEmitter.fire(this.currentFolder ?? null);
  }

  /**
   * Re-classify the first local workspace folder, which must itself be the fork
   * root, cache both the verdict and its folder URI, and log the verdict if it
   * changed. Multi-root and nested forks are out of scope (spec #20).
   */
  private detect(): void {
    const previous = this.currentFolder;
    const folder = (vscode.workspace.workspaceFolders ?? []).find(
      (candidate) => candidate.uri.scheme === 'file',
    );
    this.currentFolderUri = folder?.uri;
    const next = folder
      ? { name: folder.name, status: detectFork(createForkFs(folder.uri.fsPath)) }
      : null;
    for (const line of forkStatusLog(previous, next)) this.log.appendLine(line);
    this.currentFolder = next;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }
}
