import { DiagnosticSeverity, type Connection, type Diagnostic } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import { diagnosticsFor, type PrototypeDiagnostic, type PrototypeIndexView, type SchemaRoot } from '../core';

/** Typing lands in bursts; check a document once it settles. */
const CHECK_DEBOUNCE_MS = 300;

/** What a check needs about the document's fork, or `undefined` when it is not a prototype file of a loaded fork. */
export interface CheckContext {
  readonly schema: SchemaRoot;
  readonly index: PrototypeIndexView;
  /** The fork's build is behind its sources: the schema may lag the code. */
  readonly stale: boolean;
}

/**
 * Publishes {@link diagnosticsFor} for open prototype files: debounced after an
 * open or edit, for every open file at once when the schema or the index
 * changes ({@link recheckAll}), and cleared on close or when a file stops being
 * checkable (no fork, no schema).
 *
 * A missing prototype is an error — the index is read from the YAML on disk,
 * always current. A component or an enum value is judged against the schema,
 * which comes from the last build; while that build is stale, those are only
 * warnings and say why.
 */
export class DiagnosticsService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Documents that currently show diagnostics, so a recheck can clear them. */
  private readonly published = new Set<string>();

  constructor(
    private readonly connection: Connection,
    private readonly documentOf: (uri: string) => TextDocument | undefined,
    private readonly contextFor: (uri: string) => CheckContext | undefined,
  ) {}

  schedule(uri: string): void {
    const pending = this.timers.get(uri);
    if (pending) clearTimeout(pending);
    this.timers.set(
      uri,
      setTimeout(() => {
        this.timers.delete(uri);
        this.check(uri);
      }, CHECK_DEBOUNCE_MS),
    );
  }

  recheckAll(uris: readonly string[]): void {
    for (const uri of uris) this.schedule(uri);
  }

  close(uri: string): void {
    const pending = this.timers.get(uri);
    if (pending) clearTimeout(pending);
    this.timers.delete(uri);
    this.publish(uri, []);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private check(uri: string): void {
    const document = this.documentOf(uri);
    const context = this.contextFor(uri);
    if (!document || !context) {
      this.publish(uri, []);
      return;
    }
    const found = diagnosticsFor(document.getText(), context.schema, context.index);
    this.publish(
      uri,
      found.map((problem) => toDiagnostic(document, problem, context.stale)),
    );
  }

  private publish(uri: string, diagnostics: Diagnostic[]): void {
    // Nothing shown and nothing to show: no need to tell the client again.
    if (diagnostics.length === 0 && !this.published.has(uri)) return;
    if (diagnostics.length === 0) this.published.delete(uri);
    else this.published.add(uri);
    void this.connection.sendDiagnostics({ uri, diagnostics });
  }
}

const STALE_HINT = ' The fork build is older than its C# sources — rebuild it to refresh the schema.';

function toDiagnostic(document: TextDocument, problem: PrototypeDiagnostic, stale: boolean): Diagnostic {
  const fromSchema = problem.code !== 'unknown-prototype';
  const softened = fromSchema && stale;
  return {
    range: { start: document.positionAt(problem.range[0]), end: document.positionAt(problem.range[1]) },
    severity: softened ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    code: problem.code,
    source: 'SS14',
    message: softened ? problem.message + STALE_HINT : problem.message,
  };
}
