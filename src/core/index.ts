/**
 * Pure TypeScript core — the single test seam (spec #20, "Testing Decisions").
 *
 * Nothing in this directory may import `vscode` or the host adapter. It takes plain data in and returns plain data out, so it can be tested
 * without launching VS Code. The eslint config enforces the import boundary.
 */

export const EXTENSION_ID = 'ss14editor';
export const PUBLISHER = 'TheShuEd';

/** Fully-qualified extension identifier as VS Code reports it. */
export const QUALIFIED_EXTENSION_ID = `${PUBLISHER}.${EXTENSION_ID}`;

export { detectFork } from './fork-detection';
export type {
  ForkFs,
  ForkFolderStatus,
  ForkStatus,
  ForkRecognized,
  ForkUnrecognized,
  StaleBuild,
  ForkProblemCode,
} from './fork-detection';
export { forkStatusLog, schemaStatusLog, indexStatusLog, localeIndexStatusLog } from './status-log';

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

export {
  collectRecords,
  diffRecords,
  PrototypeIndex,
  INDEX_CACHE_FORMAT,
  indexFingerprint,
  serializeIndexCache,
  parseIndexCache,
  PROTOTYPE_ROOTS,
  prototypeRootOf,
  indexBuilding,
  indexReady,
  indexFailed,
} from './prototype-index';
export type {
  PrototypeRecord,
  CollectResult,
  RecordDiff,
  IndexLookup,
  IndexStatus,
  PrototypeIndexView,
} from './prototype-index';

export { completionsAt, opensSuggestOnNewLine, reopensSuggestAfterDeletion } from './completion';
export { componentNameRanges, diagnosticsFor } from './diagnostics';
export type { DiagnosticCode, PrototypeDiagnostic } from './diagnostics';
export type { CompletionCandidate } from './completion';
export type { ResourceEntry, ResourceTree } from './resource-paths';
export { classDefinitionAt, definitionAt, fieldDefinitionAt } from './definition';
export type { ClassDefinition, DefinitionTarget, FieldDefinition } from './definition';
export { hoverAt, hoverMarkdown, readableTypeName, withSourceSummary } from './hover';
export type { ClassHover, FieldHover, HoverContent } from './hover';
export { ClassLocator, classDeclarationsIn, docSummaryBefore, memberDeclarationIn } from './class-location';
export type { ClassDeclaration, ClassLocation, CsSourceTree } from './class-location';

export {
  parsePrototypeFile,
  positionAt,
  scalarSites,
  valueScalarsOf,
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
  ScalarSite,
  NodeRange,
  TextPosition,
  FieldAddress,
  FieldResolution,
  ResolvedField,
  MissingField,
  CursorContext,
  CursorContextOptions,
  CursorToken,
  ScalarSpan,
  RegistrySite,
  SurgicalEdit,
  EditOutcome,
} from './prototype-yaml';

export { parseFluent, flattenPattern } from './fluent';
export type { FluentEntry, FluentPosition, FluentResolver } from './fluent';
export {
  LOCALE_ROOTS,
  FALLBACK_LOCALE,
  LocalizationIndex,
  localeOf,
  collectLocRecords,
  declarationSpan,
  localeIndexBuilding,
  localeIndexReady,
  localeIndexFailed,
} from './localization-index';
export type { LocRecord, LocTranslation, LocalizationIndexView, LocaleIndexStatus } from './localization-index';
export { locIdAt, locIdSpansIn, locHoverMarkdown, foldedText } from './loc-id';
export type { LocIdSpan } from './loc-id';
