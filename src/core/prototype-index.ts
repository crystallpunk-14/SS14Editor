/**
 * Prototype index — pure core (spec #20, "Индекс прототипов"; issue #28).
 *
 * The index is a flat set of raw records, one per prototype across every kind:
 * `(kind, id)` plus where it lives and what it inherits from. No AST is kept and
 * inheritance is not resolved here. This module owns the two pure halves the
 * host adapter (worker, watcher, cache, status log) is built on:
 *
 *   - {@link collectRecords}: one file's text -> its records;
 *   - {@link diffRecords}: two record sets -> added / removed / changed.
 *
 * plus the in-memory store ({@link PrototypeIndex}) and the cache fingerprint
 * and on-disk format, all VS-Code-free.
 *
 * Rules, from the spec and `prototype/prototype-index-benchmark`:
 *   - Strip a leading U+FEFF before parsing (~9% of real fork files have one).
 *   - A file with any parse error is skipped as a whole — no partial records.
 *   - The key is the exact `(kind, id)` pair: no case normalisation.
 *   - Items without `type` or `id` (CreateVariants templates) are skipped.
 *   - Duplicates are kept, not diagnosed.
 */

import { createHash } from 'node:crypto';

import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Document, type YAMLMap } from 'yaml';

import type { NodeRange } from './prototype-yaml';

// ---------------------------------------------------------------------------
// Where prototypes live
// ---------------------------------------------------------------------------

/** Fork-relative prototype roots. Engine prototypes are read-only. */
export const PROTOTYPE_ROOTS = [
  { dir: 'Resources/Prototypes', engine: false },
  { dir: 'RobustToolbox/Resources/EnginePrototypes', engine: true },
] as const;

/** The root a fork-relative, `/`-separated path falls under (the root itself included). */
export function prototypeRootOf(relPath: string): (typeof PROTOTYPE_ROOTS)[number] | undefined {
  return PROTOTYPE_ROOTS.find((root) => relPath === root.dir || relPath.startsWith(`${root.dir}/`));
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One prototype, as the index sees it. Offsets are into the BOM-stripped text. */
export interface PrototypeRecord {
  readonly kind: string;
  readonly id: string;
  /** Fork-relative path with `/` separators. */
  readonly filePath: string;
  /** `[start, valueEnd, nodeEnd]` of the prototype's map. */
  readonly range: NodeRange;
  /** Raw parent ids, in declaration order. */
  readonly parents: readonly string[];
  readonly abstract: boolean;
  /** `true` for `RobustToolbox/Resources/EnginePrototypes/**` — read-only. */
  readonly engine: boolean;
}

export type CollectResult =
  | { readonly ok: true; readonly records: readonly PrototypeRecord[] }
  | { readonly ok: false; readonly errors: readonly string[] };

const BOM = 0xfeff;

/**
 * A scalar's value as a key string, or `undefined` for anything that can't be
 * one. An alias resolves to its anchor first — real tabletop prototypes write
 * `id: *Board` against an anchor set deeper in the previous prototype.
 */
function scalarString(node: unknown, doc: Document): string | undefined {
  const target = isAlias(node) ? node.resolve(doc) : node;
  if (!isScalar(target)) return undefined;
  const { value } = target;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function parentsOf(item: YAMLMap, doc: Document): string[] {
  const node = item.get('parent', true);
  if (isSeq(node)) {
    return node.items
      .map((p) => scalarString(p, doc))
      .filter((p): p is string => p !== undefined && p !== '');
  }
  const single = scalarString(node, doc);
  return single === undefined || single === '' ? [] : [single];
}

function isAbstract(item: YAMLMap, doc: Document): boolean {
  const node = item.get('abstract', true);
  const target = isAlias(node) ? node.resolve(doc) : node;
  if (!isScalar(target)) return false;
  return target.value === true || target.value === 'true';
}

/**
 * Collect the records of one prototype file. Parses every document of the
 * stream; a document whose root is not a sequence is ignored (the engine logs
 * and skips it too).
 */
export function collectRecords(rawText: string, filePath: string, engine: boolean): CollectResult {
  const text = rawText.charCodeAt(0) === BOM ? rawText.slice(1) : rawText;
  const docs = parseAllDocuments(text, { strict: false, prettyErrors: false });

  const errors = docs.flatMap((doc) => doc.errors).map((err) => err.message);
  if (errors.length > 0) return { ok: false, errors };

  const records: PrototypeRecord[] = [];
  for (const doc of docs) {
    const root = doc.contents;
    if (!isSeq(root)) continue;
    for (const item of root.items) {
      if (!isMap(item) || !item.range) continue;
      const kind = scalarString(item.get('type', true), doc);
      const id = scalarString(item.get('id', true), doc);
      if (kind === undefined || id === undefined) continue;
      const [start, valueEnd, nodeEnd] = item.range;
      records.push({
        kind,
        id,
        filePath,
        range: [start, valueEnd, nodeEnd],
        parents: parentsOf(item, doc),
        abstract: isAbstract(item, doc),
        engine,
      });
    }
  }
  return { ok: true, records };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface RecordDiff {
  readonly added: readonly PrototypeRecord[];
  readonly removed: readonly PrototypeRecord[];
  readonly changed: readonly { readonly before: PrototypeRecord; readonly after: PrototypeRecord }[];
}

function keyOf(kind: string, id: string): string {
  // NUL cannot appear in a YAML plain scalar, so the pair stays unambiguous.
  return `${kind}\0${id}`;
}

function sameRecord(a: PrototypeRecord, b: PrototypeRecord): boolean {
  return (
    a.filePath === b.filePath &&
    a.abstract === b.abstract &&
    a.engine === b.engine &&
    a.range[0] === b.range[0] &&
    a.range[1] === b.range[1] &&
    a.range[2] === b.range[2] &&
    a.parents.length === b.parents.length &&
    a.parents.every((p, i) => p === b.parents[i])
  );
}

/** Diff two record sets by `(kind, id)`. Within one set, a duplicate key keeps its first record. */
export function diffRecords(
  before: readonly PrototypeRecord[],
  after: readonly PrototypeRecord[],
): RecordDiff {
  const old = new Map<string, PrototypeRecord>();
  for (const r of before) {
    const key = keyOf(r.kind, r.id);
    if (!old.has(key)) old.set(key, r);
  }

  const added: PrototypeRecord[] = [];
  const changed: { before: PrototypeRecord; after: PrototypeRecord }[] = [];
  const seen = new Set<string>();
  for (const r of after) {
    const key = keyOf(r.kind, r.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = old.get(key);
    if (prev === undefined) added.push(r);
    else if (!sameRecord(prev, r)) changed.push({ before: prev, after: r });
  }

  const removed = [...old].filter(([key]) => !seen.has(key)).map(([, r]) => r);
  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/** A lookup answer: before the first load the index says "not ready", never "absent". */
export type IndexLookup =
  | { readonly ready: false }
  | { readonly ready: true; readonly record: PrototypeRecord | undefined };

/**
 * The read side of {@link PrototypeIndex} — what the text providers consume
 * (issue #33). A snapshot in the sense that providers only read it, at the
 * moment they are asked.
 */
export type PrototypeIndexView = Pick<PrototypeIndex, 'ready' | 'get' | 'all'>;

/**
 * The live index: records grouped by file (the unit of incremental update) and
 * by `(kind, id)` (the unit of lookup). Duplicate keys across files are all
 * kept, so dropping one file never hides its twin in another.
 */
export class PrototypeIndex {
  private readonly byFile = new Map<string, readonly PrototypeRecord[]>();
  private readonly byKey = new Map<string, PrototypeRecord[]>();
  private loaded = false;

  get ready(): boolean {
    return this.loaded;
  }

  get size(): number {
    let n = 0;
    for (const records of this.byFile.values()) n += records.length;
    return n;
  }

  get(kind: string, id: string): IndexLookup {
    if (!this.loaded) return { ready: false };
    return { ready: true, record: this.byKey.get(keyOf(kind, id))?.[0] };
  }

  *all(): Iterable<PrototypeRecord> {
    for (const records of this.byFile.values()) yield* records;
  }

  files(): string[] {
    return [...this.byFile.keys()];
  }

  /** Back to "not ready" with nothing in it — the fork went away or a rebuild started. */
  reset(): void {
    this.byFile.clear();
    this.byKey.clear();
    this.loaded = false;
  }

  /** Full (re)load — cold build, cache hit, or rebuild. Marks the index ready. */
  replaceAll(records: readonly PrototypeRecord[]): void {
    this.byFile.clear();
    this.byKey.clear();
    const grouped = new Map<string, PrototypeRecord[]>();
    for (const r of records) {
      const list = grouped.get(r.filePath);
      if (list) list.push(r);
      else grouped.set(r.filePath, [r]);
    }
    for (const [filePath, list] of grouped) this.setFile(filePath, list);
    this.loaded = true;
  }

  /**
   * Replace one file's records (re-parsed on save; `[]` for a deleted file) and
   * return what changed in it.
   */
  updateFile(filePath: string, records: readonly PrototypeRecord[]): RecordDiff {
    const before = this.byFile.get(filePath) ?? [];
    for (const r of before) {
      const key = keyOf(r.kind, r.id);
      const list = this.byKey.get(key);
      if (!list) continue;
      const remaining = list.filter((x) => x !== r);
      if (remaining.length > 0) this.byKey.set(key, remaining);
      else this.byKey.delete(key);
    }
    this.byFile.delete(filePath);
    if (records.length > 0) this.setFile(filePath, records);
    return diffRecords(before, records);
  }

  private setFile(filePath: string, records: readonly PrototypeRecord[]): void {
    this.byFile.set(filePath, records);
    for (const r of records) {
      const key = keyOf(r.kind, r.id);
      const list = this.byKey.get(key);
      if (list) list.push(r);
      else this.byKey.set(key, [r]);
    }
  }
}

// ---------------------------------------------------------------------------
// Persistent cache
// ---------------------------------------------------------------------------

/** Bump when {@link PrototypeRecord} or the cache layout changes. */
export const INDEX_CACHE_FORMAT = 1;

/**
 * Cache fingerprint over the mtime tree of every prototype file (content and
 * engine) plus `schemaVersion`. Sorted, so walk order does not matter; the path
 * list is hashed too, so an added or deleted file moves it.
 */
export function indexFingerprint(
  files: readonly { readonly path: string; readonly mtimeMs: number }[],
  schemaVersion: number,
): string {
  const hash = createHash('sha256');
  hash.update(`format=${INDEX_CACHE_FORMAT}\nschema=${schemaVersion}\n`);
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${f.path}\0${f.mtimeMs}\n`);
  }
  return hash.digest('hex');
}

type CachedRecord = [
  kind: string,
  id: string,
  filePath: string,
  start: number,
  valueEnd: number,
  nodeEnd: number,
  parents: string[],
  abstract: 0 | 1,
  engine: 0 | 1,
];

/**
 * Raw records as compact tuples — the cache is read on every activation — plus
 * the fork-relative paths of files that failed to parse, so a cache hit reports
 * the same skipped count as the cold build that wrote it.
 */
export function serializeIndexCache(
  fingerprint: string,
  records: readonly PrototypeRecord[],
  skippedFiles: readonly string[] = [],
): string {
  const rows: CachedRecord[] = records.map((r) => [
    r.kind,
    r.id,
    r.filePath,
    r.range[0],
    r.range[1],
    r.range[2],
    [...r.parents],
    r.abstract ? 1 : 0,
    r.engine ? 1 : 0,
  ]);
  return JSON.stringify({ format: INDEX_CACHE_FORMAT, fingerprint, skippedFiles, records: rows });
}

/** `undefined` for anything that is not a cache this build wrote. */
export function parseIndexCache(
  text: string,
): { fingerprint: string; records: PrototypeRecord[]; skippedFiles: string[] } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const doc = parsed as {
    format?: unknown;
    fingerprint?: unknown;
    records?: unknown;
    skippedFiles?: unknown;
  };
  if (
    typeof doc !== 'object' ||
    doc === null ||
    doc.format !== INDEX_CACHE_FORMAT ||
    typeof doc.fingerprint !== 'string' ||
    !Array.isArray(doc.records)
  ) {
    return undefined;
  }
  const records = (doc.records as CachedRecord[]).map(
    ([kind, id, filePath, start, valueEnd, nodeEnd, parents, abstract, engine]): PrototypeRecord => ({
      kind,
      id,
      filePath,
      range: [start, valueEnd, nodeEnd],
      parents,
      abstract: abstract === 1,
      engine: engine === 1,
    }),
  );
  const skippedFiles = Array.isArray(doc.skippedFiles)
    ? doc.skippedFiles.filter((f): f is string => typeof f === 'string')
    : [];
  return { fingerprint: doc.fingerprint, records, skippedFiles };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The index's progress or result, mirroring {@link import('./schema').SchemaStatus}:
 * one `state` discriminant and a `message` on every variant to be logged
 * verbatim.
 */
export type IndexStatus =
  | { readonly state: 'building'; readonly message: string; readonly done: number; readonly total: number }
  | { readonly state: 'ready'; readonly message: string; readonly count: number; readonly skippedFiles: number }
  | { readonly state: 'failed'; readonly message: string };

export function indexBuilding(done: number, total: number): IndexStatus {
  return { state: 'building', done, total, message: `Indexing prototypes… ${done}/${total} files` };
}

export function indexReady(count: number, skippedFiles: number): IndexStatus {
  return {
    state: 'ready',
    count,
    skippedFiles,
    message:
      skippedFiles > 0
        ? `Prototype index: ${count} prototypes (${skippedFiles} unparseable files skipped).`
        : `Prototype index: ${count} prototypes.`,
  };
}

export function indexFailed(reason: string): IndexStatus {
  return { state: 'failed', message: `Prototype index failed: ${reason}` };
}
