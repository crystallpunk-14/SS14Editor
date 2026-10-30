import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  CompletionItemKind,
  createConnection,
  DidChangeWatchedFilesNotification,
  MarkupKind,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem,
  type InitializeParams,
  type InitializeResult,
  type LocationLink,
  type Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import {
  ClassLocator,
  classDefinitionAt,
  completionsAt,
  definitionAt,
  detectFork,
  EXPECTED_SCHEMA_VERSION,
  hoverAt,
  hoverMarkdown,
  interpretSchemaResult,
  parseSchemaDocument,
  PROTOTYPE_ROOTS,
  PrototypeIndex,
  schemaCacheDirName,
  type CompletionCandidate,
  type SchemaRoot,
  type SchemaRunOutcome,
} from '../core';
import { createCsSourceTree, createForkFs, createResourceTree } from '../host/fork-fs';
import type { FromWorker, ToWorker } from '../host/prototype-index-worker';

/**
 * SPIKE (stage 0 of the Rider plan): the VS Code host's controllers folded into
 * one stdio language server, so any LSP client — Rider's platform LSP API first —
 * gets the same completion, hover and go-to-definition off the pure core.
 *
 * Deliberately thin: no status diffing, no debounce of DLL rebuilds, one fork
 * (the first workspace folder). Stage 1 replaces it with proper controllers.
 */

/** What the client may pass in `initializationOptions`; both default sensibly. */
interface InitOptions {
  /** Where the schema and index caches go (the IDE's per-plugin system dir). */
  readonly storagePath?: string;
  /** `SS14Editor.SchemaCli.dll`; defaults to `../assets/schema-cli/` next to `dist/`. */
  readonly schemaCliPath?: string;
}

const REBUILD_SCHEMA_COMMAND = 'ss14editor.rebuildSchema';
const REBUILD_PROTOTYPE_INDEX_COMMAND = 'ss14editor.rebuildPrototypeIndex';
const CLI_TIMEOUT_MS = 10 * 60 * 1000;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const index = new PrototypeIndex();
let forkRoot: string | undefined;
let storagePath = path.join(os.tmpdir(), 'ss14editor');
let schemaCliPath = path.join(__dirname, '..', 'assets', 'schema-cli', 'SS14Editor.SchemaCli.dll');
let schema: SchemaRoot | null = null;
let worker: Worker | undefined;
let classLocator: ClassLocator | undefined;

const log = (line: string) => connection.console.log(line);

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const options = (params.initializationOptions ?? {}) as InitOptions;
  if (options.storagePath) storagePath = options.storagePath;
  if (options.schemaCliPath) schemaCliPath = options.schemaCliPath;

  const rootUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  forkRoot = rootUri ? fileURLToPath(rootUri) : undefined;

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [' ', ':', '/'] },
      hoverProvider: true,
      definitionProvider: true,
      executeCommandProvider: { commands: [REBUILD_SCHEMA_COMMAND, REBUILD_PROTOTYPE_INDEX_COMMAND] },
    },
    serverInfo: { name: 'SS14 Prototype Editor (spike)' },
  };
});

connection.onInitialized(() => {
  void connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [
      { globPattern: '**/bin/Content.{Server,Client}/*.dll' },
      ...PROTOTYPE_ROOTS.map((root) => ({ globPattern: `**/${root.dir}/**` })),
    ],
  });
  void start(false);
});

/** Detect the fork, extract the schema, then build the index — the VS Code activation order. */
async function start(forceIndex: boolean): Promise<void> {
  if (!forkRoot) {
    log('[fork] No workspace folder: nothing to do.');
    return;
  }
  const status = detectFork(createForkFs(forkRoot));
  if (!status.recognized) {
    log(`[fork] ${status.message}`);
    return;
  }
  log(`[fork] ${forkRoot} recognized as an SS14 fork.`);
  await loadSchema();
  startIndex(forceIndex);
}

async function loadSchema(): Promise<void> {
  if (!forkRoot) return;
  const cacheDir = path.join(storagePath, 'schema', schemaCacheDirName(path.basename(forkRoot), forkRoot));
  fs.mkdirSync(cacheDir, { recursive: true });

  const started = Date.now();
  const run: SchemaRunOutcome = fs.existsSync(schemaCliPath)
    ? await invokeCli(schemaCliPath, forkRoot, cacheDir)
    : { kind: 'extractor-missing' };

  const document = readIfPresent(path.join(cacheDir, 'metadata.json'));
  const parse = document === undefined ? undefined : parseSchemaDocument(document);
  const sidecar = readIfPresent(path.join(cacheDir, 'metadata.fingerprint'));
  const status = interpretSchemaResult({
    run,
    parse,
    sidecarFingerprint: sidecar?.trim() || undefined,
    expectedVersion: EXPECTED_SCHEMA_VERSION,
  });

  schema = status.state === 'loaded' && parse?.ok ? parse.root : null;
  classLocator = undefined;
  log(`[schema] ${status.state} in ${Date.now() - started} ms${'message' in status ? `: ${status.message}` : ''}`);
}

function startIndex(force: boolean): void {
  if (!forkRoot) return;
  void worker?.terminate();
  index.reset();

  const cachePath = path.join(
    storagePath,
    'prototype-index',
    `${schemaCacheDirName(path.basename(forkRoot), forkRoot)}.json`,
  );
  const started = new Worker(path.join(__dirname, 'prototype-index-worker.js'));
  worker = started;
  started.on('message', (message: FromWorker) => {
    if (worker !== started) return;
    switch (message.type) {
      case 'loaded':
        index.replaceAll(message.records);
        log(`[index] ${message.records.length} prototypes ${message.fromCache ? 'read from cache' : 'parsed'} in ${message.elapsedMs} ms`);
        break;
      case 'updated':
        if (!index.ready) break;
        for (const file of message.files) index.updateFile(file.filePath, file.records);
        break;
      case 'log':
        log(`[index] ${message.message}`);
        break;
      case 'failed':
        log(`[index] failed: ${message.reason}`);
        break;
    }
  });
  started.on('error', (err) => log(`[index] worker crashed: ${err.stack ?? err.message}`));
  send({ type: 'build', forkRoot, cachePath, schemaVersion: EXPECTED_SCHEMA_VERSION, force });
}

function send(message: ToWorker): void {
  worker?.postMessage(message);
}

connection.onDidChangeWatchedFiles(({ changes }) => {
  const paths = changes.map((change) => fileURLToPath(change.uri));
  if (paths.some((p) => p.endsWith('.dll'))) void loadSchema();
  const prototypes = paths.filter((p) => !p.endsWith('.dll'));
  if (prototypes.length > 0) send({ type: 'update', paths: prototypes });
});

connection.onExecuteCommand(async ({ command }) => {
  if (command === REBUILD_SCHEMA_COMMAND) await loadSchema();
  else if (command === REBUILD_PROTOTYPE_INDEX_COMMAND) startIndex(true);
});

/** A prototype YAML of the open fork — what the VS Code selector matches. */
function isPrototypeDocument(uri: string): boolean {
  return /\/Resources\/Prototypes\/.+\.ya?ml$/i.test(decodeURIComponent(uri).replace(/\\/g, '/'));
}

connection.onCompletion(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document || !schema || !forkRoot || !isPrototypeDocument(textDocument.uri)) return [];
  const candidates = completionsAt(
    document.getText(),
    document.offsetAt(position),
    schema,
    index,
    createResourceTree(forkRoot),
  );
  return candidates.map((candidate) => toCompletionItem(document, candidate));
});

connection.onHover(({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document || !schema || !isPrototypeDocument(textDocument.uri)) return null;
  const hover = hoverAt(document.getText(), document.offsetAt(position), schema);
  if (!hover) return null;
  return {
    contents: { kind: MarkupKind.Markdown, value: hoverMarkdown(hover) },
    range: rangeIn(document, hover.origin),
  };
});

connection.onDefinition(async ({ textDocument, position }): Promise<LocationLink[] | null> => {
  const document = documents.get(textDocument.uri);
  if (!document || !schema || !forkRoot || !isPrototypeDocument(textDocument.uri)) return null;
  const text = document.getText();
  const offset = document.offsetAt(position);

  const found = definitionAt(text, offset, schema, index);
  if (found) {
    const [start, , end] = found.target.range;
    const link = linkTo(document, found.origin, found.target.filePath, [start, end], [start, start]);
    return link ? [link] : null;
  }

  const named = classDefinitionAt(text, offset, schema);
  if (!named) return null;
  const root = forkRoot;
  classLocator ??= new ClassLocator(createCsSourceTree(root));
  const locations = await classLocator.locate(named.className);
  const links = locations
    .map((location) => {
      const name: [number, number] = [location.offset, location.offset + location.name.length];
      return linkTo(document, named.origin, location.filePath, name, name);
    })
    .filter((link) => link !== undefined);
  return links.length > 0 ? links : null;
});

/** A link to `[start, end)` offsets of a fork-relative file, read from disk with its BOM stripped. */
function linkTo(
  document: TextDocument,
  origin: readonly [number, number],
  filePath: string,
  target: readonly [number, number],
  selection: readonly [number, number],
): LocationLink | undefined {
  if (!forkRoot) return undefined;
  const absolute = path.join(forkRoot, ...filePath.split('/'));
  const raw = readIfPresent(absolute);
  if (raw === undefined) return undefined;
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const file = TextDocument.create(pathToFileURL(absolute).toString(), 'plaintext', 0, text);
  return {
    originSelectionRange: rangeIn(document, origin),
    targetUri: file.uri,
    targetRange: rangeIn(file, target),
    targetSelectionRange: rangeIn(file, selection),
  };
}

function rangeIn(document: TextDocument, [start, end]: readonly [number, number]): Range {
  return { start: document.positionAt(start), end: document.positionAt(end) };
}

const KIND: Record<CompletionCandidate['kind'], CompletionItemKind> = {
  prototype: CompletionItemKind.Struct,
  component: CompletionItemKind.Class,
  field: CompletionItemKind.Field,
  value: CompletionItemKind.EnumMember,
  id: CompletionItemKind.Reference,
  type: CompletionItemKind.TypeParameter,
  file: CompletionItemKind.File,
  folder: CompletionItemKind.Folder,
};

/** Mirrors the VS Code adapter's `toCompletionItem`; `range` becomes an explicit `textEdit`. */
function toCompletionItem(
  document: TextDocument,
  candidate: CompletionCandidate,
): CompletionItem {
  const item: CompletionItem = { label: candidate.label, kind: KIND[candidate.kind] };
  if (candidate.detail) item.detail = candidate.detail;
  if (candidate.insertText) {
    item.insertText = candidate.insertText;
    item.filterText = candidate.label;
  }
  if (candidate.range) {
    item.textEdit = { range: rangeIn(document, candidate.range), newText: candidate.insertText ?? candidate.label };
    item.filterText = candidate.insertText ?? candidate.label;
  }
  if (candidate.filterText) item.filterText = candidate.filterText;
  // Spike: the reopen-after-accept behaviour has no LSP equivalent yet; the
  // client sees the hint and decides (stage 3).
  if (candidate.kind === 'folder' || candidate.continues) item.data = { continues: true };
  return item;
}

function invokeCli(dll: string, root: string, cacheDir: string): Promise<SchemaRunOutcome> {
  return new Promise((resolve) => {
    execFile('dotnet', [dll, root, cacheDir], { timeout: CLI_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ kind: 'dotnet-missing' });
        return;
      }
      const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ kind: 'exited', code, stderr: stderr ?? '' });
    });
  });
}

function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

documents.listen(connection);
connection.listen();
