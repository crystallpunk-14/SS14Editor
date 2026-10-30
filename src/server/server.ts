import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CompletionItemKind,
  createConnection,
  DidChangeWatchedFilesNotification,
  MarkupKind,
  ProposedFeatures,
  RequestType,
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
  hoverAt,
  hoverMarkdown,
  opensSuggestOnNewLine,
  PROTOTYPE_ROOTS,
  reopensSuggestAfterDeletion,
  type CompletionCandidate,
  type ResourceTree,
} from '../core';
import { createCsSourceTree, createResourceTree } from '../host/fork-fs';
import { DiagnosticsService } from './diagnostics-service';
import { ForkState } from './fork-state';
import { IndexService } from './index-service';
import { Reporter } from './reporter';
import { SchemaService } from './schema-service';

/**
 * Stdio language server over the pure core — the LSP counterpart of the VS Code
 * host (`src/host/`), so any LSP client (Rider first, ADR-0002) gets the same
 * completion, hover and go-to-definition.
 *
 * One fork: the first workspace folder (or `rootUri`), which must itself be the
 * fork root, as in VS Code. {@link ForkState}, {@link SchemaService} and
 * {@link IndexService} mirror the host's controllers; this file wires them to
 * the connection and maps core results to LSP types.
 */

/** What the client may pass in `initializationOptions`; both default sensibly. */
interface InitOptions {
  /** Where the schema and index caches go (the IDE's per-plugin system dir). */
  readonly storagePath?: string;
  /** `SS14Editor.SchemaCli.dll`; defaults to `../assets/schema-cli/` next to `dist/`. */
  readonly schemaCliPath?: string;
}

/**
 * Whether the client should open the completion list at `offset` after an edit
 * the editor itself never opens it on — LSP has no way to say so. `accepted`: a
 * candidate that continues (`data.continues`) was just inserted; `deletion`:
 * Backspace; `newline`: Enter. `text` and `offset` are the document as the
 * client has it now, so the answer never waits on `didChange` reaching us.
 */
interface ShouldSuggestParams {
  readonly uri: string;
  readonly text: string;
  readonly offset: number;
  readonly reason: 'accepted' | 'deletion' | 'newline';
}

const ShouldSuggestRequest = new RequestType<ShouldSuggestParams, boolean, void>('ss14/shouldSuggest');

const REBUILD_SCHEMA_COMMAND = 'ss14editor.rebuildSchema';
const REBUILD_PROTOTYPE_INDEX_COMMAND = 'ss14editor.rebuildPrototypeIndex';

/** The built DLLs fork detection and the schema read — the VS Code host watches the same. */
const DLL_GLOB = '**/bin/Content.{Server,Client}/*.dll';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const reporter = new Reporter(connection);

let rootPath: string | undefined;
let options: InitOptions = {};
let fork: ForkState | undefined;
let schema: SchemaService | undefined;
let prototypes: IndexService | undefined;
let resources: ResourceTree | undefined;
/** Created on the first component jump; dropped on every schema change, when classes may have moved. */
let classLocator: ClassLocator | undefined;

const diagnostics = new DiagnosticsService(
  connection,
  (uri) => documents.get(uri),
  (uri) => {
    const context = contextFor(uri);
    return context ? { schema: context.schema, index: context.index, stale: fork?.isStale() ?? false } : undefined;
  },
);
const recheckOpenDocuments = () => diagnostics.recheckAll(documents.keys());

connection.onInitialize((params: InitializeParams): InitializeResult => {
  options = (params.initializationOptions ?? {}) as InitOptions;
  const rootUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  rootPath = rootUri?.startsWith('file:') ? fileURLToPath(rootUri) : undefined;

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // `/` too: a ResPath value completes segment by segment (ADR-0001).
      completionProvider: { triggerCharacters: [' ', ':', '/'] },
      hoverProvider: true,
      definitionProvider: true,
      executeCommandProvider: { commands: [REBUILD_SCHEMA_COMMAND, REBUILD_PROTOTYPE_INDEX_COMMAND] },
    },
    serverInfo: { name: 'SS14 Prototype Editor' },
  };
});

connection.onInitialized(() => {
  void connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [{ globPattern: DLL_GLOB }, ...PROTOTYPE_ROOTS.map((root) => ({ globPattern: `**/${root.dir}/**` }))],
  });

  const storagePath = options.storagePath ?? path.join(os.tmpdir(), 'ss14editor');
  const cliPath =
    options.schemaCliPath ?? path.join(__dirname, '..', 'assets', 'schema-cli', 'SS14Editor.SchemaCli.dll');

  fork = new ForkState(rootPath, reporter);
  schema = new SchemaService(fork, storagePath, cliPath, reporter);
  prototypes = new IndexService(fork, storagePath, reporter);
  schema.onDidChange(() => {
    classLocator = undefined;
    recheckOpenDocuments();
  });
  fork.onDidChange(() => {
    resources = undefined;
    classLocator = undefined;
    recheckOpenDocuments();
  });
  prototypes.onDidUpdate(recheckOpenDocuments);

  // First extraction straight through, not via the DLL debounce: on an
  // unchanged fork the CLI no-ops and features are up in well under a second.
  void schema.run();
});

documents.onDidOpen(({ document }) => diagnostics.schedule(document.uri));
documents.onDidChangeContent(({ document }) => diagnostics.schedule(document.uri));
documents.onDidClose(({ document }) => diagnostics.close(document.uri));

connection.onShutdown(() => {
  diagnostics.dispose();
  prototypes?.dispose();
  schema?.dispose();
  fork?.dispose();
});

connection.onDidChangeWatchedFiles(({ changes }) => {
  const paths = changes.filter((change) => change.uri.startsWith('file:')).map((change) => fileURLToPath(change.uri));
  if (paths.some((p) => p.toLowerCase().endsWith('.dll'))) {
    fork?.scheduleRefresh();
    schema?.scheduleRun();
  }
  const prototypePaths = paths.filter((p) => !p.toLowerCase().endsWith('.dll'));
  if (prototypePaths.length > 0) prototypes?.queueUpdate(prototypePaths);
});

connection.onExecuteCommand(async ({ command }) => {
  if (command === REBUILD_SCHEMA_COMMAND) await schema?.run();
  else if (command === REBUILD_PROTOTYPE_INDEX_COMMAND) prototypes?.rebuild();
});

/**
 * What every feature needs, or `undefined` when the request is not for a
 * prototype file of the recognised fork, or the schema is not loaded — the
 * VS Code selector plus the provider registration's preconditions.
 */
function contextFor(uri: string) {
  const document = documents.get(uri);
  const root = fork?.recognizedRoot();
  const loaded = schema?.schema;
  if (!document || !root || !loaded || !prototypes || !uri.startsWith('file:')) return undefined;
  const relative = path.relative(root.path, fileURLToPath(uri)).split(path.sep).join('/');
  if (!/^Resources\/Prototypes\/.+\.ya?ml$/i.test(relative)) return undefined;
  return { document, root, schema: loaded, index: prototypes.index };
}

/** The VS Code host's `triggerSuggestOnEdit` and `ss14editor.suggestIfAny`, as one request. */
connection.onRequest(ShouldSuggestRequest, ({ uri, text, offset, reason }) => {
  const context = contextFor(uri);
  if (!context) return false;
  resources ??= createResourceTree(context.root.path);
  switch (reason) {
    case 'accepted':
      return completionsAt(text, offset, context.schema, context.index, resources).length > 0;
    case 'deletion':
      return reopensSuggestAfterDeletion(text, offset, context.schema, context.index, resources);
    case 'newline':
      return opensSuggestOnNewLine(text, offset, context.schema, context.index);
  }
});

connection.onCompletion(({ textDocument, position }) => {
  const context = contextFor(textDocument.uri);
  if (!context) return [];
  const { document, root } = context;
  resources ??= createResourceTree(root.path);
  const candidates = completionsAt(document.getText(), document.offsetAt(position), context.schema, context.index, resources);
  return candidates.map((candidate) => toCompletionItem(document, candidate));
});

connection.onHover(({ textDocument, position }) => {
  const context = contextFor(textDocument.uri);
  if (!context) return null;
  const { document } = context;
  const hover = hoverAt(document.getText(), document.offsetAt(position), context.schema);
  if (!hover) return null;
  return {
    contents: { kind: MarkupKind.Markdown, value: hoverMarkdown(hover) },
    range: rangeIn(document, hover.origin),
  };
});

/**
 * A prototype id jumps to its declaration (engine prototypes resolve the same
 * way, into `RobustToolbox/Resources/EnginePrototypes/`); a component name or a
 * `!type:` tag to its C# class — one link per part of a partial class.
 */
connection.onDefinition(async ({ textDocument, position }): Promise<LocationLink[] | null> => {
  const context = contextFor(textDocument.uri);
  if (!context) return null;
  const { document, root } = context;
  const text = document.getText();
  const offset = document.offsetAt(position);

  const found = definitionAt(text, offset, context.schema, context.index);
  if (found) {
    const [start, , end] = found.target.range;
    const link = linkTo(root.path, document, found.origin, found.target.filePath, [start, end], [start, start]);
    return link ? [link] : null;
  }

  const named = classDefinitionAt(text, offset, context.schema);
  if (!named) return null;
  classLocator ??= new ClassLocator(createCsSourceTree(root.path));
  const locations = await classLocator.locate(named.className);
  const links = locations
    .map((location) => {
      const name: [number, number] = [location.offset, location.offset + location.name.length];
      return linkTo(root.path, document, named.origin, location.filePath, name, name);
    })
    .filter((link) => link !== undefined);
  return links.length > 0 ? links : null;
});

/**
 * A link from `origin` in `document` to `[start, end)` offsets of a
 * fork-relative file — `undefined` when that file can no longer be read. Core
 * offsets are into the BOM-stripped text, so the file is read the same way.
 */
function linkTo(
  forkRoot: string,
  document: TextDocument,
  origin: readonly [number, number],
  filePath: string,
  target: readonly [number, number],
  selection: readonly [number, number],
): LocationLink | undefined {
  const absolute = path.join(forkRoot, ...filePath.split('/'));
  let raw: string;
  try {
    raw = fs.readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
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

/** Mirrors the VS Code adapter's `toCompletionItem`; a core `range` becomes an explicit `textEdit`. */
function toCompletionItem(document: TextDocument, candidate: CompletionCandidate): CompletionItem {
  const item: CompletionItem = { label: candidate.label, kind: KIND[candidate.kind] };
  if (candidate.detail) item.detail = candidate.detail;
  // Set only where the core synthesized syntax the caret needs (`type:`, a
  // colon, a `!type:` tag); `filterText` keeps the bare name matching.
  if (candidate.insertText) {
    item.insertText = candidate.insertText;
    item.filterText = candidate.label;
  }
  // A written `!type:` tag is replaced whole, so match against the full tag.
  if (candidate.range) {
    item.textEdit = { range: rangeIn(document, candidate.range), newText: candidate.insertText ?? candidate.label };
    item.filterText = candidate.insertText ?? candidate.label;
  }
  if (candidate.filterText) item.filterText = candidate.filterText;
  // Picking it leaves the caret on the next completion point; LSP has no way to
  // reopen the list, so the client asks `ss14/shouldSuggest` after inserting it.
  if (candidate.kind === 'folder' || candidate.continues) item.data = { continues: true };
  return item;
}

documents.listen(connection);
connection.listen();
