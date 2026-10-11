/**
 * Typed host <-> webview message protocol.
 *
 * Issue #21 shipped the handshake; issue #23 adds the fork-status push. Later
 * tickets extend these unions with the inspector model and field-edit intents
 * (`{ path, value, range }`). Both sides `switch` on `type`; payloads are never
 * untyped `postMessage` blobs (spec #20).
 */

import type { ForkStatus, IndexStatus, SchemaStatus } from '../core';

export interface HelloMessage {
  type: 'hello';
  extensionVersion: string;
}

export interface ReadyMessage {
  type: 'ready';
}

/** The workspace folder that was checked, plus the verdict for it. */
export interface ForkFolderStatus {
  name: string;
  status: ForkStatus;
}

/**
 * The host's current read of the workspace fork. `folder` is `null` when no
 * local folder is open. Re-sent on folder changes, on DLL changes, and whenever
 * the view becomes visible again (the webview is torn down while hidden).
 */
export interface ForkStatusMessage {
  type: 'forkStatus';
  folder: ForkFolderStatus | null;
}

/**
 * The host's current read of the fork schema. `status` is `null` when the fork
 * is not a recognised, freshly-built fork (there is nothing to extract a schema
 * from). Re-sent after every extractor run — on activation, after a debounced
 * DLL change, and on the `SS14: Rebuild schema` command — and whenever the view
 * becomes visible again. `SchemaStatus` is a summary only; the full schema
 * object stays in the host for the provider tickets.
 */
export interface SchemaStatusMessage {
  type: 'schemaStatus';
  status: SchemaStatus | null;
}

/**
 * The prototype index's progress or result (issue #28). `status` is `null` when
 * the fork is not a recognised, freshly-built fork. Re-sent on build progress,
 * when a build or cache load finishes, after every incremental update, and
 * whenever the view becomes visible again.
 */
export interface IndexStatusMessage {
  type: 'indexStatus';
  status: IndexStatus | null;
}

/** Messages the host sends to the webview. */
export type HostToWebview =
  | HelloMessage
  | ForkStatusMessage
  | SchemaStatusMessage
  | IndexStatusMessage;

/** Messages the webview sends to the host. */
export type WebviewToHost = ReadyMessage;
