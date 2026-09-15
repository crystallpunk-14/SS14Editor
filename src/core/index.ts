/**
 * Pure TypeScript core — the single test seam (spec #20, "Testing Decisions").
 *
 * Nothing in this directory may import `vscode`, the host adapter, or the webview
 * bundle. It takes plain data in and returns plain data out, so it can be tested
 * without launching VS Code. The eslint config enforces the import boundary.
 */

export const EXTENSION_ID = 'ss14editor';
export const PUBLISHER = 'crystallpunk-14';

/** Fully-qualified extension identifier as VS Code reports it. */
export const QUALIFIED_EXTENSION_ID = `${PUBLISHER}.${EXTENSION_ID}`;

/**
 * Ids of the extension's own activity-bar container and the inspector view it
 * hosts. Live here (vscode-free) so the host, the smoke test, and `package.json`
 * share one source rather than scattered literals.
 */
export const VIEW_CONTAINER_ID = 'ss14editor';
export const INSPECTOR_VIEW_ID = 'ss14editor.inspector';

export { generateNonce } from './nonce';
export { renderWebviewHtml } from './webview-html';
export type { WebviewHtmlOptions } from './webview-html';
export { detectFork } from './fork-detection';
export type {
  ForkFs,
  ForkStatus,
  ForkRecognized,
  ForkUnrecognized,
  ForkProblemCode,
} from './fork-detection';

export {
  EXPECTED_SCHEMA_VERSION,
  schemaCacheDirName,
  parseSchemaDocument,
  interpretSchemaResult,
} from './schema';
export type {
  SchemaParse,
  SchemaRunOutcome,
  SchemaResultInput,
  SchemaStatus,
} from './schema';
export type {
  SchemaRoot,
  PrototypeMetadata,
  ComponentMetadata,
  DataDefinitionMetadata,
  FieldMetadata,
  FieldTypeNode,
  EnumConstantEntry,
} from './schema-contract';

export { completionsAt } from './completion';
export type { CompletionCandidate } from './completion';

export {
  parsePrototypeFile,
  positionAt,
  resolveField,
  cursorContextAt,
  replaceScalarValue,
  replaceBlockScalarValue,
  insertField,
  insertComponent,
  deleteAt,
} from './prototype-yaml';
export type {
  ParseResult,
  PrototypeFile,
  PrototypeParseError,
  NodeRange,
  TextPosition,
  FieldAddress,
  FieldResolution,
  ResolvedField,
  MissingField,
  CursorContext,
  CursorContextOptions,
  CursorToken,
  RegistrySite,
  SurgicalEdit,
  EditOutcome,
} from './prototype-yaml';
