import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort } from 'node:worker_threads';

import {
  collectRecords,
  indexFingerprint,
  parseIndexCache,
  PROTOTYPE_ROOTS,
  PrototypeIndex,
  prototypeRootOf,
  serializeIndexCache,
  type PrototypeRecord,
} from '../core/prototype-index';

/**
 * Worker thread behind the prototype index (issue #28). Every YAML parse — the
 * ~6 s cold build over `crystall-edge` and the per-file re-parse on save — runs
 * here, so the Extension Host thread never blocks on it.
 *
 * The worker owns the authoritative record set and the on-disk cache; the host
 * mirrors it into its own {@link PrototypeIndex} from the messages below.
 * Messages are handled one at a time, so an update that arrives during a build
 * is applied after it.
 *
 * Every file's mtime is captured just before it is read, and the cache
 * fingerprint is built from those — never from a fresh walk — so a cache can
 * only claim the mtimes its records were actually parsed at. A change the
 * watcher missed leaves the fingerprint stale, and the next activation simply
 * rebuilds cold.
 *
 * It reads only the fork and writes only `cachePath` (under `globalStorageUri`).
 */

export type ToWorker =
  | {
      readonly type: 'build';
      readonly forkRoot: string;
      readonly cachePath: string;
      readonly schemaVersion: number;
      /** Skip the cache and parse every file (`SS14: Rebuild prototype index`). */
      readonly force: boolean;
    }
  /** Absolute paths of files or folders that were saved, created or deleted. */
  | { readonly type: 'update'; readonly paths: readonly string[] };

export type FromWorker =
  | { readonly type: 'progress'; readonly done: number; readonly total: number }
  | {
      readonly type: 'loaded';
      readonly records: readonly PrototypeRecord[];
      readonly skippedFiles: number;
      readonly fromCache: boolean;
      readonly elapsedMs: number;
    }
  /** Fresh records per touched file; `[]` for a file that was deleted, emptied or broken. */
  | {
      readonly type: 'updated';
      readonly files: readonly { readonly filePath: string; readonly records: readonly PrototypeRecord[] }[];
      readonly skippedFiles: number;
    }
  | { readonly type: 'log'; readonly message: string }
  | { readonly type: 'failed'; readonly reason: string };

const PROGRESS_EVERY = 100;
const PERSIST_DEBOUNCE_MS = 1000;

interface FileEntry {
  readonly abs: string;
  /** Fork-relative, `/`-separated — the record's `filePath`. */
  readonly rel: string;
  readonly engine: boolean;
}

interface State {
  readonly forkRoot: string;
  readonly cachePath: string;
  readonly schemaVersion: number;
  readonly index: PrototypeIndex;
  /** Every known prototype file (fork-relative) -> the mtime it was last read at. */
  readonly mtimes: Map<string, number>;
  /** Files whose last parse failed (fork-relative). They contribute no records. */
  readonly broken: Set<string>;
}

let state: State | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function post(message: FromWorker): void {
  parentPort?.postMessage(message);
}

function isYaml(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

function toRel(forkRoot: string, abs: string): string {
  return path.relative(forkRoot, abs).split(path.sep).join('/');
}

/** Every prototype file under `dir`. Dot-entries are skipped, as the engine does. */
function walk(forkRoot: string, dir: string, engine: boolean, out: FileEntry[] = []): FileEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(forkRoot, abs, engine, out);
    else if (isYaml(entry.name)) out.push({ abs, rel: toRel(forkRoot, abs), engine });
  }
  return out;
}

function walkRoots(forkRoot: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const root of PROTOTYPE_ROOTS) walk(forkRoot, path.join(forkRoot, ...root.dir.split('/')), root.engine, out);
  return out;
}

function mtimeOf(abs: string): number | undefined {
  try {
    return fs.statSync(abs).mtimeMs;
  } catch {
    return undefined;
  }
}

function fingerprintOf(s: State): string {
  return indexFingerprint(
    [...s.mtimes].map(([rel, mtimeMs]) => ({ path: rel, mtimeMs })),
    s.schemaVersion,
  );
}

/**
 * (Re)read one file into the state. A file that is gone is forgotten; a file
 * that does not parse is skipped (logged) and contributes no records — the same
 * on save as in a cold build, so the cache and a rebuild always agree.
 */
function refresh(s: State, file: FileEntry): readonly PrototypeRecord[] {
  const mtimeMs = mtimeOf(file.abs);
  let text: string | undefined;
  try {
    text = mtimeMs === undefined ? undefined : fs.readFileSync(file.abs, 'utf8');
  } catch {
    text = undefined;
  }
  if (mtimeMs === undefined || text === undefined) {
    forget(s, file.rel);
    return [];
  }

  s.mtimes.set(file.rel, mtimeMs);
  const result = collectRecords(text, file.rel, file.engine);
  if (result.ok) {
    s.broken.delete(file.rel);
  } else {
    s.broken.add(file.rel);
    post({ type: 'log', message: `skipped ${file.rel}: ${result.errors[0]}` });
  }
  const records = result.ok ? result.records : [];
  s.index.updateFile(file.rel, records);
  return records;
}

function forget(s: State, rel: string): void {
  s.mtimes.delete(rel);
  s.broken.delete(rel);
  s.index.updateFile(rel, []);
}

function writeCache(s: State): void {
  try {
    fs.mkdirSync(path.dirname(s.cachePath), { recursive: true });
    fs.writeFileSync(s.cachePath, serializeIndexCache(fingerprintOf(s), [...s.index.all()], [...s.broken]));
  } catch (err) {
    post({ type: 'log', message: `could not write the index cache: ${(err as Error).message}` });
  }
}

function readCache(cachePath: string): ReturnType<typeof parseIndexCache> {
  try {
    return parseIndexCache(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function build(message: Extract<ToWorker, { type: 'build' }>): void {
  const started = Date.now();
  if (persistTimer) clearTimeout(persistTimer);
  const s: State = {
    forkRoot: message.forkRoot,
    cachePath: message.cachePath,
    schemaVersion: message.schemaVersion,
    index: new PrototypeIndex(),
    mtimes: new Map(),
    broken: new Set(),
  };
  state = s;

  const files = walkRoots(s.forkRoot);

  if (!message.force) {
    for (const file of files) {
      const mtimeMs = mtimeOf(file.abs);
      if (mtimeMs !== undefined) s.mtimes.set(file.rel, mtimeMs);
    }
    const cached = readCache(s.cachePath);
    if (cached?.fingerprint === fingerprintOf(s)) {
      s.index.replaceAll(cached.records);
      for (const rel of cached.skippedFiles) s.broken.add(rel);
      post({
        type: 'loaded',
        records: cached.records,
        skippedFiles: s.broken.size,
        fromCache: true,
        elapsedMs: Date.now() - started,
      });
      return;
    }
    s.mtimes.clear();
  }

  s.index.replaceAll([]);
  post({ type: 'progress', done: 0, total: files.length });
  for (const [i, file] of files.entries()) {
    refresh(s, file);
    if ((i + 1) % PROGRESS_EVERY === 0) post({ type: 'progress', done: i + 1, total: files.length });
  }

  writeCache(s);
  post({
    type: 'loaded',
    records: [...s.index.all()],
    skippedFiles: s.broken.size,
    fromCache: false,
    elapsedMs: Date.now() - started,
  });
}

/**
 * Re-read what the watcher reported. A path may be a file or a whole folder
 * (VS Code reports a deleted or renamed folder once, by its own path): every
 * known file under it is re-read or forgotten, and every file now on disk under
 * it is read.
 */
function update(paths: readonly string[]): void {
  const s = state;
  if (!s) return;

  const touched = new Map<string, FileEntry>();
  for (const abs of new Set(paths)) {
    const rel = toRel(s.forkRoot, abs);
    const root = prototypeRootOf(rel);
    if (!root || rel.split('/').some((part) => part.startsWith('.'))) continue;

    for (const known of s.mtimes.keys()) {
      if (known === rel || known.startsWith(`${rel}/`)) {
        touched.set(known, { abs: path.join(s.forkRoot, ...known.split('/')), rel: known, engine: root.engine });
      }
    }
    if (isYaml(rel)) touched.set(rel, { abs, rel, engine: root.engine });
    for (const file of walk(s.forkRoot, abs, root.engine)) touched.set(file.rel, file);
  }

  const files = [...touched.values()].map((file) => ({ filePath: file.rel, records: refresh(s, file) }));
  post({ type: 'updated', files, skippedFiles: s.broken.size });
  schedulePersist(s);
}

/** Coalesce a burst of saves into one cache write. */
function schedulePersist(s: State): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    if (state === s) writeCache(s);
  }, PERSIST_DEBOUNCE_MS);
}

parentPort?.on('message', (message: ToWorker) => {
  try {
    switch (message.type) {
      case 'build':
        build(message);
        break;
      case 'update':
        update(message.paths);
        break;
    }
  } catch (err) {
    post({ type: 'failed', reason: (err as Error).message });
  }
});
