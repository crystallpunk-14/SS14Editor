import * as vscode from 'vscode';

import { generateNonce, renderWebviewHtml } from '../core';
import type { HelloMessage, WebviewToHost } from '../shared/protocol';
import type { ForkStatusController } from './fork-status-controller';
import type { PrototypeIndexController } from './prototype-index-controller';
import type { SchemaController } from './schema-controller';

export { INSPECTOR_VIEW_ID } from '../core';

/**
 * Sidebar webview view for the prototype inspector.
 *
 * Issue #21 shipped the shell (single ESM script tag, strict CSP, typed
 * handshake). Issue #23 adds the fork-detection status, issue #25 the schema
 * status and issue #28 the prototype-index status: on `ready` the provider hands
 * the live view to the three controllers, which push their current verdicts and
 * keep them fresh. Real inspector
 * behaviour (cards, tree, widgets) comes in later tickets.
 */
export class InspectorViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionVersion: string,
    private readonly forkStatus: ForkStatusController,
    private readonly schemaStatus: SchemaController,
    private readonly prototypeIndex: PrototypeIndexController,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // Scoped to the webview bundle folder only — not the whole `dist/`, which
    // also holds the host bundle (issue #23 acceptance criterion).
    const bundleUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [bundleUri],
    };

    const scriptUri = webviewView.webview
      .asWebviewUri(vscode.Uri.joinPath(bundleUri, 'main.js'))
      .toString();

    webviewView.webview.html = renderWebviewHtml({
      scriptUri,
      cspSource: webviewView.webview.cspSource,
      nonce: generateNonce(),
    });

    webviewView.webview.onDidReceiveMessage((message: WebviewToHost) => {
      switch (message.type) {
        case 'ready': {
          const hello: HelloMessage = {
            type: 'hello',
            extensionVersion: this.extensionVersion,
          };
          void webviewView.webview.postMessage(hello);
          this.forkStatus.bind(webviewView);
          this.schemaStatus.bind(webviewView);
          this.prototypeIndex.bind(webviewView);
          break;
        }
      }
    });
  }
}
