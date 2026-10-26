/**
 * Schema contract — the shape of the `metadata.json` the C# CLI (issue #22)
 * emits, as consumed by the TypeScript side (spec #20, "Схема: контракт, кэш,
 * инвалидация"; issue #25).
 *
 * The spec allows either hand-writing these types once or generating them from
 * the CLI's `MetadataModels`. They are hand-written here and kept in sync with
 * `schema-cli/vendor/MetadataModels.cs` by hand — the contract changes rarely and
 * a bump to {@link EXPECTED_SCHEMA_VERSION} (mirroring `Program.SchemaVersion`)
 * is the tripwire when it does.
 *
 * JSON key casing is `System.Text.Json`'s camelCase policy: `Prototypes` in C#
 * becomes `prototypes` here.
 */

/**
 * Schema-document shape version the extension is built against. Must equal the
 * CLI's `Content.Editor.Program.SchemaVersion`. When the CLI emits a different
 * value the loaded document is treated as incompatible and no providers come up
 * (issue #25 acceptance criterion).
 */
export const EXPECTED_SCHEMA_VERSION = 1;

/** One named enum member value (see {@link SchemaRoot.enumConstants}). */
export interface EnumConstantEntry {
  readonly name: string;
  readonly value: number;
}

/**
 * Recursive type-tree node for one level of a field's declared type. `element`
 * is the item type of a list/array; `key` + `value` are a dictionary's; children
 * nest to any depth.
 */
export interface FieldTypeNode {
  readonly kind: string;
  readonly fullType?: string;
  readonly protoTypeArg?: string;
  readonly enumValues?: readonly string[];
  readonly enumRef?: string;
  readonly isDataDefinition?: boolean;
  readonly dataDefinitionType?: string;
  readonly element?: FieldTypeNode;
  readonly key?: FieldTypeNode;
  readonly value?: FieldTypeNode;
  readonly tupleElements?: readonly FieldTypeNode[];
}

/** One serialisable field of a component, `[DataDefinition]` or `[Prototype]` type. */
export interface FieldMetadata {
  readonly name: string;
  readonly tag: string;
  readonly type: string;
  readonly fullType: string;
  readonly fieldKind: string;
  readonly required: boolean;
  readonly isId: boolean;
  readonly isParent: boolean;
  readonly isAbstract: boolean;
  readonly alwaysPushInheritance?: boolean;
  readonly neverPushInheritance?: boolean;
  readonly protoTypeArg?: string;
  readonly enumValues?: readonly string[];
  readonly enumRef?: string;
  /** True when {@link default} carries a meaningful IL-scanned initializer (JSON `null` included). */
  readonly hasDefault?: boolean;
  readonly default?: unknown;
  readonly element?: FieldTypeNode;
  readonly key?: FieldTypeNode;
  readonly value?: FieldTypeNode;
  readonly tupleElements?: readonly FieldTypeNode[];
  readonly isDataDefinition?: boolean;
  readonly dataDefinitionType?: string;
  readonly summary?: string;
}

export interface PrototypeMetadata {
  readonly className: string;
  readonly yamlType: string;
  readonly inheriting: boolean;
  readonly summary?: string;
  readonly fields: readonly FieldMetadata[];
}

export interface ComponentMetadata {
  readonly className: string;
  readonly name: string;
  readonly summary?: string;
  readonly fields: readonly FieldMetadata[];
}

export interface DataDefinitionMetadata {
  readonly className: string;
  readonly shortName: string;
  readonly summary?: string;
  readonly fields: readonly FieldMetadata[];
}

/**
 * The whole schema document: the predecessor's `MetadataRoot` verbatim plus the
 * two contract roots the CLI splices in front (`schemaVersion`,
 * `sourceFingerprint`). This is the single in-memory object the text providers
 * read.
 */
export interface SchemaRoot {
  readonly schemaVersion: number;
  /** SHA-256 the CLI computed over its input DLLs + its own version. */
  readonly sourceFingerprint: string;
  readonly prototypes: Readonly<Record<string, PrototypeMetadata>>;
  readonly components: Readonly<Record<string, ComponentMetadata>>;
  readonly dataDefinitions: Readonly<Record<string, DataDefinitionMetadata>>;
  readonly polymorphicTypes: Readonly<Record<string, readonly string[]>>;
  readonly enumConstants: Readonly<Record<string, readonly EnumConstantEntry[]>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
}
