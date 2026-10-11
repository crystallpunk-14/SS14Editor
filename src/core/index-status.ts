/**
 * Prototype-index status for the panel (issue #28). Dependency-free on purpose:
 * the webview bundle imports it directly, and must not drag `yaml` or
 * `node:crypto` from the rest of the index core into the browser.
 */

export type IndexStatus =
  | { readonly state: 'building'; readonly done: number; readonly total: number }
  | { readonly state: 'ready'; readonly count: number; readonly skippedFiles: number }
  | { readonly state: 'failed'; readonly reason: string };

export function indexStatusMessage(status: IndexStatus): string {
  switch (status.state) {
    case 'building':
      return `Indexing prototypes… ${status.done}/${status.total} files`;
    case 'ready':
      return status.skippedFiles > 0
        ? `Prototype index: ${status.count} prototypes (${status.skippedFiles} unparseable files skipped).`
        : `Prototype index: ${status.count} prototypes.`;
    case 'failed':
      return `Prototype index failed: ${status.reason}`;
  }
}
