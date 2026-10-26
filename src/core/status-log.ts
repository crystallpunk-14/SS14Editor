import type { ForkFolderStatus } from './fork-detection';
import type { IndexStatus } from './prototype-index';
import type { SchemaStatus } from './schema';

/**
 * Status lines for the "SS14 Editor" Output channel (issue #45).
 *
 * The Output channel is the only place the fork, schema and index verdicts
 * surface — no status-bar item, no toast, no modal. Each function takes the
 * previously reported status (`undefined` before the first report) and the new
 * one, and returns the lines to append: empty when nothing a user would care
 * about changed, so re-detections and progress ticks do not flood the log.
 */

export function forkStatusLog(
  previous: ForkFolderStatus | null | undefined,
  next: ForkFolderStatus | null,
): string[] {
  return changed(previous === undefined ? undefined : forkLines(previous), forkLines(next));
}

/** A `null` schema means "not a recognised fork" — the fork line already says why. */
export function schemaStatusLog(
  previous: SchemaStatus | null | undefined,
  next: SchemaStatus | null,
): string[] {
  return changed(previous === undefined ? undefined : schemaLines(previous), schemaLines(next));
}

/** A build logs its start once; progress ticks share that line and stay silent. */
export function indexStatusLog(
  previous: IndexStatus | null | undefined,
  next: IndexStatus | null,
): string[] {
  return changed(previous === undefined ? undefined : indexLines(previous), indexLines(next));
}

function forkLines(folder: ForkFolderStatus | null): string[] {
  if (folder === null) return ['[fork] No local folder is open. Open an SS14 fork folder to get started.'];
  const { name, status } = folder;
  if (!status.recognized) return [`[fork] ${name}: ${status.message}`];
  const lines = [`[fork] ${name}: SS14 fork recognized.`];
  if (status.stale) lines.push(`[fork] ${name}: ${status.stale.message}`);
  return lines;
}

function schemaLines(status: SchemaStatus | null): string[] {
  if (status === null) return [];
  const lines = [`[schema] ${status.message}`];
  if (status.state === 'extraction-failed' && status.stderr) {
    for (const line of status.stderr.split(/\r?\n/)) lines.push(`[schema]   ${line}`);
  }
  return lines;
}

function indexLines(status: IndexStatus | null): string[] {
  if (status === null) return [];
  if (status.state === 'building') return ['[index] Indexing prototypes…'];
  return [`[index] ${status.message}`];
}

/** `next` when it differs from `previous` (nothing reported yet counts as different), else `[]`. */
function changed(previous: string[] | undefined, next: string[]): string[] {
  if (previous !== undefined && previous.join('\n') === next.join('\n')) return [];
  return next;
}
