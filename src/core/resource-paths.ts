/**
 * Path candidates for a field declared `ResPath` (issue #32; ADR-0001). There
 * is no resource index: each request lists the one directory of `Resources/`
 * the value typed so far points into, fresh from the {@link ResourceTree}, so a
 * file added on disk is offered by the very next request. Whether a field is a
 * `ResPath` is {@link completionsAt}'s call; this module only turns the
 * caret's partial path into a directory and that directory into candidates.
 */

import type { CompletionCandidate } from './completion';

/** One entry of a `Resources/` directory. */
export interface ResourceEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/**
 * The fork's `Resources/`, one directory at a time. `relPath` is relative to
 * `Resources/`, `/`-separated, `''` for the root, and never holds `.`/`..` or an
 * empty segment. `undefined` when it is not a listable directory; a throw is
 * read the same way.
 */
export interface ResourceTree {
  listDir(relPath: string): readonly ResourceEntry[] | undefined;
}

/**
 * The entries of the directory the caret's partial path names, each replacing
 * the segment under the caret: a file by its name, a directory by its name and
 * a `/` so the path can be continued. A first segment typed without its `/` is
 * rooted on insert — a `ResPath` the engine loads is absolute under
 * `Resources/`. `insertPrefix` is the space the caret's empty slot still lacks;
 * with it there is nothing typed yet. Empty for a prefix that is not a plain
 * path or names no directory.
 */
export function resourcePathCandidates(
  text: string,
  offset: number,
  tree: ResourceTree,
  insertPrefix: string,
): CompletionCandidate[] {
  const typed = insertPrefix ? '' : typedValueAt(text, offset);
  const lastSlash = typed.lastIndexOf('/');
  // `/Maps/Shuttles/arr` -> `Maps/Shuttles`; a leading `/` is `Resources/` itself.
  const dirStart = typed.startsWith('/') ? 1 : 0;
  const dir = lastSlash === -1 ? '' : typed.slice(dirStart, lastSlash);
  if (dir !== '' && !dir.split('/').every(isPlainSegment)) return [];

  const entries = listOrNothing(tree, dir);
  if (!entries) return [];

  const segmentStart = offset - typed.length + lastSlash + 1;
  const range = [segmentStart, segmentEndAt(text, offset)] as const;
  const root = lastSlash === -1 ? '/' : '';

  return entries
    .map((entry): CompletionCandidate => ({
      label: entry.name,
      kind: entry.isDirectory ? 'folder' : 'file',
      insertText: `${insertPrefix}${root}${entry.name}${entry.isDirectory ? '/' : ''}`,
      // Filtered against the segment being typed, not the `/` the insert may add.
      filterText: entry.name,
      range,
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/**
 * The value written before the caret: the last run free of whitespace and flow
 * punctuation (`[a, b]`), past an opening quote.
 */
const TYPED_VALUE = /(?:^|[\s[{,])['"]?([^\s'"[\]{},]*)$/;

/** Characters that end a path segment after the caret. */
const SEGMENT_END = /[\s'"/[\]{},]/;

function typedValueAt(text: string, offset: number): string {
  return TYPED_VALUE.exec(text.slice(lineStartAt(text, offset), offset))?.[1] ?? '';
}

function isPlainSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\\');
}

function listOrNothing(tree: ResourceTree, dir: string): readonly ResourceEntry[] | undefined {
  try {
    return tree.listDir(dir);
  } catch {
    return undefined;
  }
}

/** Where the path segment the caret is in ends — at the next `/`, quote, space or line end. */
function segmentEndAt(text: string, offset: number): number {
  let end = offset;
  while (end < text.length && !SEGMENT_END.test(text[end])) end++;
  return end;
}

function lineStartAt(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}
