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
export type StatusLog<T> = (previous: T | null | undefined, next: T | null) => string[];

export const forkStatusLog: StatusLog<ForkFolderStatus> = statusLog(forkLines);

/** A `null` schema means "not a recognised fork" — the fork line already says why. */
export const schemaStatusLog: StatusLog<SchemaStatus> = statusLog(schemaLines);

/**
 * A build logs its start once (progress ticks share that line) and a failure.
 * A ready index is left to the controller: its load line carries the timing and
 * skipped files, and each save gets its own per-file diff line.
 */
export const indexStatusLog: StatusLog<IndexStatus> = statusLog(indexLines);

function statusLog<T>(lines: (status: T | null) => string[]): StatusLog<T> {
  return (previous, next) =>
    linesIfChanged(previous === undefined ? undefined : lines(previous), lines(next));
}

function forkLines(folder: ForkFolderStatus | null): string[] {
  if (folder === null) return ['[fork] No local folder is open. Open an SS14 fork folder to get started.'];
  const { name, status } = folder;
  if (!status.recognized) return prefixed(`[fork] ${name}:`, status.message);
  const lines = [`[fork] ${name}: SS14 fork recognized.`];
  if (status.stale) lines.push(...prefixed(`[fork] ${name}:`, status.stale.message));
  return lines;
}

/** The message already embeds the (clipped) extractor stderr where there is one. */
function schemaLines(status: SchemaStatus | null): string[] {
  return status === null ? [] : prefixed('[schema]', status.message);
}

function indexLines(status: IndexStatus | null): string[] {
  if (status === null || status.state === 'ready') return [];
  if (status.state === 'building') return ['[index] Indexing prototypes…'];
  return prefixed('[index]', status.message);
}

/** One log line per message line, each carrying the prefix. */
function prefixed(prefix: string, message: string): string[] {
  return message.split(/\r?\n/).map((line) => `${prefix} ${line}`);
}

/** `next` when it differs from `previous` (nothing reported yet counts as different), else `[]`. */
function linesIfChanged(previous: string[] | undefined, next: string[]): string[] {
  if (previous !== undefined && previous.join('\n') === next.join('\n')) return [];
  return next;
}
