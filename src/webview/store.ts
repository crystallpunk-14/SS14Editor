import type { SchemaStatus } from '../core';
import { indexStatusMessage, type IndexStatus } from '../core/index-status';
import type { ForkFolderStatus } from '../shared/protocol';

/**
 * The webview's whole state and its renderer.
 *
 * Issues #23 and #25 keep this deliberately small: one plain object, one pure
 * `render(root, state)`. It exists now so the inspector ticket extends a real
 * store instead of inventing one — and so there is never an ambient mutable
 * `window.state` like the predecessor had. The CSP forbids inline styles, so the
 * panel is plain themed text.
 */
export interface ViewState {
  extensionVersion: string | undefined;
  /** `null` until the host's first push, or when no local folder is open. */
  folder: ForkFolderStatus | null;
  /** `null` until the first extractor run, or when the fork is not a built fork. */
  schema: SchemaStatus | null;
  /** `null` until the index starts building, or when the fork is not a built fork. */
  index: IndexStatus | null;
}

export const initialState: ViewState = {
  extensionVersion: undefined,
  folder: null,
  schema: null,
  index: null,
};

export function render(root: HTMLElement, state: ViewState): void {
  const lines = [statusText(state), indexText(state)].filter((line): line is string => line !== null);
  root.replaceChildren(
    ...lines.map((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      return div;
    }),
  );
}

/**
 * One unified status line (spec #20 — no toast, no modal). When the folder is
 * not a recognised, freshly-built fork, that reason wins. Once it is, the schema
 * verdict takes over — "loaded" with counts, or the concrete failure reason.
 */
function statusText(state: ViewState): string {
  const { folder, schema } = state;
  if (folder === null) return 'Open an SS14 fork folder to get started.';
  if (!folder.status.recognized) return folder.status.message;
  if (schema === null) return '✓ SS14 fork recognized. Extracting schema…';
  return schema.message;
}

/** The prototype index's own line (issue #28), under the fork/schema line. */
function indexText(state: ViewState): string | null {
  if (state.folder === null || !state.folder.status.recognized || state.index === null) return null;
  return indexStatusMessage(state.index);
}
