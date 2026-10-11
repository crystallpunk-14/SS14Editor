import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort } from 'node:worker_threads';

import {
  collectRecords,
  indexFingerprint,
  parseIndexCache,
  serializeIndexCache,
  type PrototypeRecord,
} from '../core/prototype-index';

/**
 * Worker thread behind the prototype index (issue #28). Every YAML parse — the
 * ~7 s cold build over `crystall-edge` and the per-file re-parse on save — runs
 * here, so the Extension Host thread never blocks on it.
 *
 * The worker owns the authoritative per-file record set and the on-disk cache;
 * the host mirrors it into a {@link import('../core/prototype-index').PrototypeIndex}
 * from the messages below. Messages are handled one at a time, so an update that
 * arrives during a build is applied after it.
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
  /** Absolute paths that were saved, created or deleted. */
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
  /** Fresh records per touched file; `[]` for a file that was deleted or emptied. */
  | {
      readonly type: 'updated';
      readonly files: readonly { readonly filePath: string; readonly records: readonly PrototypeRecord[] }[];
      readonly skippedFiles: number;
    }
  | { readonly type: 'log'; readonly message: string }
  | { readonly type: 'failed'; readonly reason: string };

/** Fork-relative prototype roots; the second is the engine's, read-only. */
const ROOTS = [
  { rel: 'Resources/Prototypes', engine: false },
  { rel: 'RobustToolbox/Resources/EnginePrototypes', engine: true },
] as const;

const PROGRESS_EVERY = 100;
const PERSIST_DEBOUNCE_MS = 1000;

interface FileEntry {
  readonly abs: string;
  /** Fork-relative, `/`-separated — the record's `filePath`. */
  readonly rel: string;
  readonly engine: boolean;
  readonly mtimeMs: number;
}

interface State {
  readonly forkRoot: string;
  readonly cachePath: string;
  readonly schemaVersion: number;
  readonly byFile: Map<string, readonly PrototypeRecord[]>;
  /** Files whose last parse failed (fork-relative). */
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

function rootOf(rel: string): (typeof ROOTS)[number] | undefined {
  return ROOTS.find((root) => rel.startsWith(`${root.rel}/`));
}

/** Every prototype file with its mtime. Dot-entries are skipped, as the engine does. */
function walk(forkRoot: string): FileEntry[] {
  const out: FileEntry[] = [];
  const visit = (dir: string, engine: boolean): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs, engine);
      } else if (isYaml(entry.name)) {
        try {
          out.push({ abs, rel: toRel(forkRoot, abs), engine, mtimeMs: fs.statSync(abs).mtimeMs });
        } catch {
          // Vanished between readdir and stat.
        }
      }
    }
  };
  for (const root of ROOTS) visit(path.join(forkRoot, ...root.rel.split('/')), root.engine);
  return out;
}

function fingerprintOf(s: Pick<State, 'schemaVersion'>, files: readonly FileEntry[]): string {
  return indexFingerprint(
    files.map((f) => ({ path: f.rel, mtimeMs: f.mtimeMs })),
    s.schemaVersion,
  );
}

/** Parse one file; `undefined` when it is unreadable or not valid YAML (logged). */
function parseFile(abs: string, rel: string, engine: boolean): readonly PrototypeRecord[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    post({ type: 'log', message: `skipped ${rel}: ${(err as Error).message}` });
    return undefined;
  }
  const result = collectRecords(text, rel, engine);
  if (!result.ok) {
    post({ type: 'log', message: `skipped ${rel}: ${result.errors[0]}` });
    return undefined;
  }
  return result.records;
}

function flatten(byFile: Map<string, readonly PrototypeRecord[]>): PrototypeRecord[] {
  const all: PrototypeRecord[] = [];
  for (const records of byFile.values()) all.push(...records);
  return all;
}

function writeCache(s: State, fingerprint: string): void {
  try {
    fs.mkdirSync(path.dirname(s.cachePath), { recursive: true });
    fs.writeFileSync(s.cachePath, serializeIndexCache(fingerprint, flatten(s.byFile), [...s.broken]));
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
    byFile: new Map(),
    broken: new Set(),
  };
  state = s;

  const files = walk(s.forkRoot);
  const fingerprint = fingerprintOf(s, files);

  if (!message.force) {
    const cached = readCache(s.cachePath);
    if (cached?.fingerprint === fingerprint) {
      for (const r of cached.records) {
        const list = s.byFile.get(r.filePath);
        if (list) (list as PrototypeRecord[]).push(r);
        else s.byFile.set(r.filePath, [r]);
      }
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
  }

  post({ type: 'progress', done: 0, total: files.length });
  for (const [i, file] of files.entries()) {
    const records = parseFile(file.abs, file.rel, file.engine);
    if (records === undefined) s.broken.add(file.rel);
    else if (records.length > 0) s.byFile.set(file.rel, records);
    if ((i + 1) % PROGRESS_EVERY === 0) post({ type: 'progress', done: i + 1, total: files.length });
  }

  writeCache(s, fingerprint);
  post({
    type: 'loaded',
    records: flatten(s.byFile),
    skippedFiles: s.broken.size,
    fromCache: false,
    elapsedMs: Date.now() - started,
  });
}

function update(paths: readonly string[]): void {
  const s = state;
  if (!s) return;

  const files: { filePath: string; records: readonly PrototypeRecord[] }[] = [];
  for (const abs of new Set(paths)) {
    const rel = toRel(s.forkRoot, abs);
    const root = rootOf(rel);
    if (!root || !isYaml(rel) || rel.split('/').some((part) => part.startsWith('.'))) continue;

    let records: readonly PrototypeRecord[] | undefined;
    if (fs.existsSync(abs)) {
      records = parseFile(abs, rel, root.engine);
      if (records === undefined) {
        // Mid-edit garbage: keep what the file last indexed to.
        s.broken.add(rel);
        continue;
      }
    } else {
      records = [];
    }
    s.broken.delete(rel);
    if (records.length > 0) s.byFile.set(rel, records);
    else s.byFile.delete(rel);
    files.push({ filePath: rel, records });
  }

  post({ type: 'updated', files, skippedFiles: s.broken.size });
  schedulePersist(s);
}

/** Coalesce a burst of saves into one cache write; the fingerprint is re-walked at write time. */
function schedulePersist(s: State): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    if (state === s) writeCache(s, fingerprintOf(s, walk(s.forkRoot)));
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
