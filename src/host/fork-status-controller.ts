import * as vscode from 'vscode';

import { detectFork } from '../core';
import type { ForkFolderStatus, ForkStatusMessage } from '../shared/protocol';
import { createForkFs } from './fork-fs';

const REFRESH_DEBOUNCE_MS = 300;

/**
 * Owns the fork-detection verdict and keeps the inspector webview in sync with
 * it (issue #23).
 *
 * The panel is a persistent `WebviewView`, so the webview document is destroyed
 * whenever the view is hidden and rebuilt when shown; the controller re-pushes
 * on `onDidChangeVisibility`. It also re-runs detection when the workspace
 * folders change or the built DLLs change on disk, so a "build is stale" warning
 * clears after a rebuild without a window reload (spec #20, "Инвалидация").
 *
 * Issue #25 makes the verdict observable: {@link onDidChange} fires on every
 * re-detection and {@link folder} exposes the current read, so the schema
 * controller can (re)run the extractor exactly when the fork becomes — or stops
 * being — a recognised, freshly-built fork.
 */
export class ForkStatusController implements vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private viewBinding: vscode.Disposable | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private currentFolder: ForkFolderStatus | null = null;
  private currentFolderUri: vscode.Uri | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<ForkFolderStatus | null>();

  /** Fires after every re-detection with the fresh verdict (or `null` if no local folder). */
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
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

  /**
   * Attach the live webview view and push the current verdict immediately.
   * Safe to call again when the view is re-resolved after being hidden — the
   * previous visibility subscription is replaced, not stacked.
   */
  bind(view: vscode.WebviewView): void {
    this.view = view;
    this.viewBinding?.dispose();
    this.viewBinding = view.onDidChangeVisibility(() => {
      if (view.visible) this.push();
    });
    this.push();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  private refresh(): void {
    this.detect();
    this.push();
    this.changeEmitter.fire(this.currentFolder);
  }

  private push(): void {
    const message: ForkStatusMessage = { type: 'forkStatus', folder: this.currentFolder };
    void this.view?.webview.postMessage(message);
  }

  /**
   * Re-classify the first local workspace folder, which must itself be the fork
   * root, and cache both the verdict and its folder URI. Multi-root and nested
   * forks are out of scope (spec #20).
   */
  private detect(): void {
    const folder = (vscode.workspace.workspaceFolders ?? []).find(
      (candidate) => candidate.uri.scheme === 'file',
    );
    this.currentFolderUri = folder?.uri;
    this.currentFolder = folder
      ? { name: folder.name, status: detectFork(createForkFs(folder.uri.fsPath)) }
      : null;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.viewBinding?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
