import * as vscode from 'vscode';

import {
  ClassLocator,
  completionsAt,
  componentDefinitionAt,
  definitionAt,
  opensSuggestOnNewLine,
  reopensSuggestAfterDeletion,
  type CompletionCandidate,
  type PrototypeIndexView,
  type SchemaRoot,
} from '../core';
import { createCsSourceTree } from './fork-fs';
import type { ForkStatusController } from './fork-status-controller';
import type { SchemaController } from './schema-controller';

/**
 * The language-feature providers that read the prototype schema (spec #20,
 * "Текстовые провайдеры"; issue #27 ships the first — completion).
 *
 * All of them share one registration and one document selector: YAML files under
 * `Resources/Prototypes/**` of the recognised fork, and only while a schema is
 * loaded. {@link SchemaController.onDidChange} fires on every fork- and
 * schema-status change, so this controller re-evaluates the selector then —
 * bringing the providers up when a fork's schema loads and tearing them down
 * when it stops being a recognised, freshly-built fork. Until then the providers
 * are simply not registered, so they stay silent (issue #27 acceptance
 * criterion: "до готовности схемы провайдер молчит").
 *
 * Go-to-definition (issue #33) registers alongside completion, on the same
 * {@link selectorFor} selector; VS Code serves a `DefinitionProvider` on both
 * Ctrl+Click and F12. Both also read the prototype index, which is consulted
 * per request rather than gating the registration: until it is ready, ids
 * simply have no candidates and no target. The same provider jumps from a
 * component name to its C# class (issue #31) through a {@link ClassLocator},
 * which caches what it reads until the next schema change. Hover (a later
 * ticket) registers here too.
 */
export class TextProviderController implements vscode.Disposable {
  private registration: vscode.Disposable | undefined;
  /** Fork root the current registration is scoped to — so an unchanged status is a no-op. */
  private registeredRoot: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Created on the first component jump; dropped on every schema change, when classes may have moved. */
  private classLocator: ClassLocator | undefined;

  constructor(
    private readonly forkStatus: ForkStatusController,
    private readonly schema: SchemaController,
    private readonly prototypeIndex: PrototypeIndexView,
  ) {
    this.disposables.push(
      this.schema.onDidChange(() => {
        this.classLocator = undefined;
        this.sync();
      }),
    );
    this.sync();
  }

  private sync(): void {
    const root = this.forkStatus.recognizedRoot();
    const wantedRoot = root && this.schema.schema !== null ? root.uri.toString() : undefined;

    // Leave an existing registration (and any open completion session) alone
    // when nothing that shapes it has changed.
    if (wantedRoot === this.registeredRoot) return;

    this.registration?.dispose();
    this.registration = undefined;
    this.registeredRoot = wantedRoot;
    // A locator reads one fork's sources; a new root needs a new one.
    this.classLocator = undefined;
    if (!root || wantedRoot === undefined) return;

    const selector = selectorFor(root.uri);
    const getSchema = () => this.schema.schema;
    const forkPath = root.uri.fsPath;
    const getLocator = () => (this.classLocator ??= new ClassLocator(createCsSourceTree(forkPath)));
    this.registration = vscode.Disposable.from(
      vscode.languages.registerCompletionItemProvider(
        selector,
        new PrototypeCompletionProvider(getSchema, this.prototypeIndex),
        ' ',
        ':',
      ),
      vscode.languages.registerDefinitionProvider(
        selector,
        new PrototypeDefinitionProvider(getSchema, this.prototypeIndex, getLocator, root.uri),
      ),
      triggerSuggestOnEdit(selector, getSchema, this.prototypeIndex),
    );
  }

  dispose(): void {
    this.registration?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** `TextDocumentChangeReason` (VS Code 1.64+; not in the 1.49 typings this builds against). */
const UNDO_OR_REDO = new Set([1, 2]);

/**
 * VS Code opens the suggestion list on typing, but never on Backspace or Enter:
 * going back into a wrong value and deleting part of it shows nothing until the
 * next letter, and neither does the fresh line after a finished `field: value`.
 * After either edit in the active prototype editor, open the list where the
 * core ({@link reopensSuggestAfterDeletion}, {@link opensSuggestOnNewLine}) says
 * there is something to offer.
 */
function triggerSuggestOnEdit(
  selector: vscode.DocumentSelector,
  getSchema: () => SchemaRoot | null,
  index: PrototypeIndexView,
): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument((event) => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document !== event.document || vscode.languages.match(selector, event.document) === 0) return;
    if (UNDO_OR_REDO.has((event as { reason?: number }).reason ?? 0)) return;

    const changes = event.contentChanges;
    const schema = getSchema();
    if (!schema || changes.length === 0) return;

    const [only] = changes;
    if (changes.length === 1 && only.text === '' && only.rangeLength > 0) {
      // A deletion leaves the caret where the removed range started.
      const offset = event.document.offsetAt(only.range.start);
      if (reopensSuggestAfterDeletion(event.document.getText(), offset, schema, index)) triggerSuggest();
      return;
    }

    // Enter arrives as a newline plus auto-indent — sometimes alongside a
    // second change trimming the whitespace it left on the line above, so the
    // caret is read once the editor has settled rather than from the offsets.
    if (!changes.some((change) => NEW_LINE.test(change.text))) return;
    setTimeout(() => {
      if (vscode.window.activeTextEditor !== editor || editor.selections.length !== 1) return;
      const offset = editor.document.offsetAt(editor.selection.active);
      if (opensSuggestOnNewLine(editor.document.getText(), offset, schema, index)) triggerSuggest();
    }, 0);
  });
}

/** What Enter inserts: a line break and the new line's indentation, nothing else. */
const NEW_LINE = /^\r?\n[ \t]*$/;

function triggerSuggest(): void {
  void vscode.commands.executeCommand('editor.action.triggerSuggest');
}

/** YAML prototype files of one fork — the selector every schema-aware provider shares. */
export function selectorFor(forkRoot: vscode.Uri): vscode.DocumentSelector {
  return {
    language: 'yaml',
    scheme: 'file',
    pattern: new vscode.RelativePattern(forkRoot, 'Resources/Prototypes/**/*.{yml,yaml}'),
  };
}

/**
 * Thin adapter: hand the document text and caret offset to the core, wrap each
 * candidate in a `CompletionItem`. All parsing, cursor-context and candidate
 * logic is in the pure core ({@link completionsAt}); nothing YAML- or
 * schema-specific lives here.
 */
export class PrototypeCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly getSchema: () => SchemaRoot | null,
    private readonly index: PrototypeIndexView,
  ) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const schema = this.getSchema();
    if (!schema) return undefined;

    // `document.getText()` is already BOM-free (VS Code strips it from the
    // model) and `offsetAt` counts over that same text, so offsets line up with
    // what the core parses.
    const candidates = completionsAt(document.getText(), document.offsetAt(position), schema, this.index);
    return candidates.map((candidate) => toCompletionItem(document, candidate));
  }
}

/**
 * Thin adapter over {@link definitionAt}: the core names the declaration as a
 * fork-relative path plus offsets, this opens that file to turn the offsets into
 * a range. Engine prototypes resolve the same way, into
 * `RobustToolbox/Resources/EnginePrototypes/`.
 *
 * On a component name it asks {@link componentDefinitionAt} for the class and
 * the {@link ClassLocator} for its declarations instead — one link per part of a
 * partial class, so VS Code jumps straight to a single one and peeks several.
 */
export class PrototypeDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private readonly getSchema: () => SchemaRoot | null,
    private readonly index: PrototypeIndexView,
    private readonly getLocator: () => ClassLocator,
    private readonly forkRoot: vscode.Uri,
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.LocationLink[] | undefined> {
    const schema = this.getSchema();
    if (!schema) return undefined;

    const text = document.getText();
    const offset = document.offsetAt(position);
    const found = definitionAt(text, offset, schema, this.index);
    if (found) {
      const [start, , end] = found.target.range;
      const link = await this.linkTo(document, found.origin, found.target.filePath, [start, end], [start, start]);
      return link && [link];
    }

    const component = componentDefinitionAt(text, offset, schema);
    if (!component) return undefined;
    const locations = await this.getLocator().locate(component.className);
    const links = await Promise.all(
      locations.map((location) => {
        const name: [number, number] = [location.offset, location.offset + location.name.length];
        return this.linkTo(document, component.origin, location.filePath, name, name);
      }),
    );
    const opened = links.filter((link) => link !== undefined);
    return opened.length > 0 ? opened : undefined;
  }

  /**
   * A link from `origin` in `document` to `[start, end)` offsets of a
   * fork-relative file — `undefined` when that file can no longer be opened (it
   * went away since it was indexed or listed). Core offsets are into the
   * BOM-stripped text, which is what a `TextDocument` holds too.
   */
  private async linkTo(
    document: vscode.TextDocument,
    origin: readonly [number, number],
    filePath: string,
    target: readonly [number, number],
    selection: readonly [number, number],
  ): Promise<vscode.LocationLink | undefined> {
    const targetUri = vscode.Uri.joinPath(this.forkRoot, ...filePath.split('/'));
    let file: vscode.TextDocument;
    try {
      file = await vscode.workspace.openTextDocument(targetUri);
    } catch {
      return undefined;
    }
    const range = ([start, end]: readonly [number, number]) =>
      new vscode.Range(file.positionAt(start), file.positionAt(end));

    return {
      originSelectionRange: new vscode.Range(document.positionAt(origin[0]), document.positionAt(origin[1])),
      targetUri,
      targetRange: range(target),
      targetSelectionRange: range(selection),
    };
  }
}

const KIND: Record<CompletionCandidate['kind'], vscode.CompletionItemKind> = {
  prototype: vscode.CompletionItemKind.Struct,
  component: vscode.CompletionItemKind.Class,
  field: vscode.CompletionItemKind.Field,
  value: vscode.CompletionItemKind.EnumMember,
  id: vscode.CompletionItemKind.Reference,
  type: vscode.CompletionItemKind.TypeParameter,
};

function toCompletionItem(document: vscode.TextDocument, candidate: CompletionCandidate): vscode.CompletionItem {
  const item = new vscode.CompletionItem(candidate.label, KIND[candidate.kind]);
  if (candidate.detail) item.detail = candidate.detail;
  // Set only where the core had to synthesize syntax the caret needs (`type:`,
  // a colon, a `!type:` tag); `filterText` keeps the bare name matching what the
  // author actually types.
  if (candidate.insertText) {
    item.insertText = candidate.insertText;
    item.filterText = candidate.label;
  }
  // A written `!type:` tag is replaced whole, and VS Code filters on the text
  // from the range start — `!type:Weap` — so match it against the full tag.
  if (candidate.range) {
    item.range = new vscode.Range(document.positionAt(candidate.range[0]), document.positionAt(candidate.range[1]));
    item.filterText = candidate.insertText ?? candidate.label;
  }
  return item;
}
