/**
 * Autocomplete candidates for prototype YAML (spec #20, "Текстовые провайдеры";
 * issue #27). Pure core: text + offset + schema snapshot in, a list of
 * candidates as plain data out. The host adapter ({@link file://../host/text-providers.ts})
 * wraps each candidate in a `vscode.CompletionItem`; nothing here knows about
 * VS Code.
 *
 * The cursor context is entirely {@link cursorContextAt}'s job (issue #24) — this
 * module never walks the YAML tree itself. From that context it decides which of
 * six lists the caret is asking for:
 *
 *   1. component names   — on the `type:` value slot of a component-registry entry;
 *   2. component fields  — on a key inside a component block;
 *   3. DataDefinition fields — on a key inside a nested `[DataDefinition]` value;
 *   4. prototype fields  — on a key at the top level of the prototype, keyed by
 *      its `[Prototype]` type (`entity` -> `EntityPrototype`, `reagent` ->
 *      `ReagentPrototype`, …);
 *   5. field values      — on a value slot, for the field kinds whose whole
 *      domain the schema carries: `boolean`, and the enum-backed `enum`/`flags`;
 *   6. prototype types   — on the `type:` value slot of the prototype itself,
 *      one level out from (1).
 *
 * Cases 2–4 exclude keys already written in the caret's block
 * ({@link CursorContext.containerKeys}). The schema keys prototypes by their
 * YAML `type:` string and components by their registration name, which is what
 * the cursor context hands us.
 *
 * ## Where a component can be
 *
 * A `ComponentRegistry` is an ordinary field type, so (1) and (2) are not tied
 * to `components:` on the prototype. A registry is equally legal on a component
 * (`ComponentToggler.removeComponents`), inside a nested `[DataDefinition]`
 * (`SlotDefinition.dependsOnComponents`) or inside a `!type:` union member
 * (`!type:AddComponentSpecial` on `job.special`) — at any depth, through lists
 * and dictionaries. So this module answers the walk's registry question from the
 * schema ({@link contextAt}) instead of naming registry keys up front, and the
 * chain the context reports is counted from the innermost component.
 *
 * The same walk carries the `!type:` tag of each step, because a tagged value is
 * the one place the declared type is not the whole answer: the field declares an
 * abstract base and only the tag names the member whose fields to offer.
 *
 * ## Mid-edit recovery
 *
 * A caret being typed at almost never sits in a well-formed tree, and `yaml`'s
 * failure modes here are all silent:
 *
 *   - a bare word with no colon (`shader`) either makes `yaml` reject the
 *     document or — worse — parses as the *scalar value* of the line above
 *     (`damage:` + `wei` => `damage: "wei"`), valid-looking but wrong;
 *   - a blank line, and an empty value slot (`type: ` with nothing after it),
 *     sit past the end of every node range, so there is no context at all;
 *   - a bare `- ` is a sequence marker, not a key — reading it as one lands the
 *     caret on the *enclosing* map and answers with that map's fields.
 *
 * So {@link completionsAt} rewrites the caret line and parses that instead:
 * `<indent><partial><sentinel>:` for a key in progress, `<indent>- type:
 * <sentinel>` for a bare `- `, and `<key>: <sentinel>` for an empty value slot.
 * The indent places the caret in the right block; the sentinel is a real token,
 * so the caret falls inside a node range, and it is distinct from every written
 * sibling, so all of them are excluded from the suggestions. Nothing from the
 * patched text reaches a candidate — labels come only from the schema.
 *
 * Where the rewrite had to invent the `type:` key (the bare `- ` case), the
 * candidates carry it back as {@link CompletionCandidate.insertText}, so picking
 * one writes the key the document is still missing.
 */

import {
  cursorContextAt,
  parsePrototypeFile,
  type CursorContext,
  type PrototypeFile,
} from './prototype-yaml';
import type {
  DataDefinitionMetadata,
  FieldMetadata,
  FieldTypeNode,
  SchemaRoot,
} from './schema-contract';

/** One completion candidate as data: what to show, how to badge it, a short signature. */
export interface CompletionCandidate {
  /** The name shown in the list — a prototype/component name, a field key, an enum member. */
  readonly label: string;
  readonly kind: 'prototype' | 'component' | 'field' | 'value';
  /** Short right-aligned signature: a declared type, a class name, or an enum type. */
  readonly detail?: string;
  /**
   * Text to insert when it differs from {@link label} — set only where the caret
   * sits on a bare `- ` and the `type:` key it needs is still missing, so picking
   * `Clothing` writes `type: Clothing`, not `Clothing`.
   */
  readonly insertText?: string;
}

/**
 * Candidates for the caret at `offset` in `text`, given the loaded `schema`.
 * Empty when the caret is not on one of the five completion points, the schema
 * has nothing to offer there, or the text cannot be parsed even after the
 * bare-key recovery below.
 */
export function completionsAt(
  text: string,
  offset: number,
  schema: SchemaRoot,
): CompletionCandidate[] {
  const resolved = resolveCursor(text, offset, schema);
  if (!resolved) return [];
  const { ctx, insertPrefix, keyNeedsColon } = resolved;

  switch (ctx.token.kind) {
    case 'component-type':
      return componentNameCandidates(schema, insertPrefix);
    case 'key':
      return fieldKeyCandidates(ctx, schema, keyNeedsColon);
    case 'value':
      return onPrototypeTypeSlot(ctx)
        ? prototypeNameCandidates(schema, insertPrefix)
        : valueCandidates(ctx, schema);
    default:
      return [];
  }
}

/**
 * True on the value slot of a prototype's own `type:` — the sibling of the
 * component-name point, one level out. `cursorContextAt` reports a component's
 * `type:` as its own `component-type` token, so a plain `type` value token on
 * the prototype map can only be this.
 */
function onPrototypeTypeSlot(ctx: CursorContext): boolean {
  return ctx.component === null && ctx.fieldPath.length === 1 && ctx.fieldPath[0] === 'type';
}

// ---------------------------------------------------------------------------
// cursor context, with mid-edit recovery
// ---------------------------------------------------------------------------

/**
 * A key `yaml` will never confuse with a real one, low-sorting and dotless so a
 * partial like `sha` + sentinel still reads as one plain key.
 */
const KEY_SENTINEL = 'zzzss14completionzzz';

/**
 * `<indent>` then an optional partial key, with no `:` anywhere on the line.
 * A key may not *start* with `-`: that is a sequence marker, and letting it in
 * turned a bare `  - ` into a key on the prototype map, which then answered with
 * the prototype's own fields.
 */
const KEY_IN_PROGRESS = /^([ \t]*)((?:[A-Za-z0-9_.][A-Za-z0-9_.-]*)?)[ \t]*$/;

/** `<indent>-` and nothing else: a sequence item whose first key is not typed yet. */
const SEQ_ITEM_START = /^([ \t]*)-([ \t]*)$/;

/** A written `key:` with an empty value slot after it — `- type: ` included. */
const EMPTY_VALUE_SLOT = /^(.*:)([ \t]*)$/;

/** What the caret line was rewritten to, if anything, so candidates can match it. */
interface ResolvedCursor {
  readonly ctx: CursorContext;
  /** Prepended to a candidate's insert text when the recovery synthesized `type:`. */
  readonly insertPrefix: string;
  /**
   * The caret line has no `:` yet, so a field-key candidate should insert its
   * own — `swingLeft` -> `swingLeft: ` — landing the caret on the value slot.
   */
  readonly keyNeedsColon: boolean;
}

/**
 * The cursor context for `offset`, applying the mid-edit recovery from this
 * module's header. `null` only when the text cannot be parsed at all.
 *
 * A caret line with no `:` is always a key-or-item in progress, so it is
 * rewritten even when the document happens to parse — that is the case `yaml`
 * silently reads as the previous line's scalar. A line that does have its `:`
 * only needs help when the direct read came back with nothing, which happens
 * when the caret sits in an empty value slot past the end of every node range.
 */
function resolveCursor(text: string, offset: number, schema: SchemaRoot): ResolvedCursor | null {
  const direct = parsePrototypeFile(text);
  const directCtx = direct.ok ? contextAt(direct, offset, schema) : null;
  const line = lineAround(text, offset);
  const keyNeedsColon = !line.includes(':');

  const rewrites = keyNeedsColon
    ? [withTypeKey(text, offset, line), withSentinelKey(text, offset, line)]
    : directCtx === null || directCtx.token.kind === 'none'
      ? [withValueSentinel(text, offset, line)]
      : [];

  for (const rewrite of rewrites) {
    if (!rewrite) continue;
    const retry = parsePrototypeFile(rewrite.text);
    if (!retry.ok) continue;
    const ctx = contextAt(retry, rewrite.offset, schema);
    if (rewrite.expect.includes(ctx.token.kind)) {
      return { ctx, insertPrefix: rewrite.insertPrefix, keyNeedsColon };
    }
  }

  return directCtx ? { ctx: directCtx, insertPrefix: '', keyNeedsColon } : null;
}

/**
 * Read the cursor context, answering the walk's "is this field a component
 * registry?" from the schema.
 *
 * `ComponentRegistry` is an ordinary field type, not a structural feature of the
 * document: `entity` happens to call its registry `components`, but `borgType`
 * calls one `addComponents`, `antagSpecifier` declares two, and a registry is
 * just as legal on a component (`ComponentToggler.removeComponents`) or inside a
 * nested `[DataDefinition]` (`SlotDefinition.dependsOnComponents`) at any depth.
 * So the answer is the declared `fieldKind` of whatever field the chain lands
 * on — the same lookup the field candidates use, never a name match.
 */
function contextAt(file: PrototypeFile, offset: number, schema: SchemaRoot): CursorContext {
  return cursorContextAt(file, offset, {
    isComponentRegistry: (site) => fieldAt(site, schema)?.fieldKind === COMPONENT_REGISTRY_KIND,
  });
}

/** `FieldMetadata.fieldKind` the CLI emits for a `ComponentRegistry`-typed field. */
const COMPONENT_REGISTRY_KIND = 'componentRegistry';

/**
 * The caret's line, without its terminator. A CRLF file's `\r` is trimmed here
 * and left in the text — {@link withSentinelKey} rewrites only up to the `\r`,
 * so the original line ending survives the patch. Missing this is invisible:
 * every regex below simply stops matching and recovery silently does nothing.
 */
function lineAround(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const nextNewline = text.indexOf('\n', offset);
  const line = text.slice(start, nextNewline === -1 ? text.length : nextNewline);
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** One candidate rewrite of the caret line, and the tokens that confirm it landed. */
interface Rewrite {
  readonly text: string;
  readonly offset: number;
  /** Token kinds that mean the rewrite put the caret where it was meant to go. */
  readonly expect: readonly CursorContext['token']['kind'][];
  readonly insertPrefix: string;
}

/** Offset of the start of the line `offset` sits on. */
function lineStartAt(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/**
 * Rewrite the caret line to `<indent><partial><sentinel>:` and report the offset
 * to read the context at (the boundary between the user's partial and the
 * sentinel). `null` when the line is not a key-in-progress shape.
 */
function withSentinelKey(text: string, offset: number, line: string): Rewrite | null {
  const match = KEY_IN_PROGRESS.exec(line);
  if (!match) return null;

  const [, indent, partial] = match;
  const start = lineStartAt(text, offset);
  const rewritten = `${indent}${partial}${KEY_SENTINEL}:`;

  return {
    text: text.slice(0, start) + rewritten + text.slice(start + line.length),
    offset: start + indent.length + partial.length,
    expect: ['key'],
    insertPrefix: '',
  };
}

/**
 * A bare `- ` starts a sequence item whose first key is always `type:` — a new
 * component under `components:`, or a new prototype at the top level. Rewrite it
 * to `<indent>- type: ` and read the context at that value slot, so the caret
 * lands on the existing component-name / prototype-name point instead of on a
 * key of the enclosing map. The `type: ` it borrows is not in the document, so
 * candidates carry it as their insert prefix.
 */
function withTypeKey(text: string, offset: number, line: string): Rewrite | null {
  const match = SEQ_ITEM_START.exec(line);
  if (!match) return null;

  const [, indent, gap] = match;
  const start = lineStartAt(text, offset);
  // The sentinel is a real scalar, so the value node has a range the caret can
  // fall inside; an empty `type: ` slot ends before the caret and reads as
  // outside every node.
  const rewritten = `${indent}- type: ${KEY_SENTINEL}`;

  return {
    text: text.slice(0, start) + rewritten + text.slice(start + line.length),
    offset: rewritten.length - KEY_SENTINEL.length + start,
    // Inside `components:` the caret lands on the component-name point; at the
    // top level of the file the same slot is the prototype's own `type:` value.
    expect: ['component-type', 'value'],
    // `-Clothing` would be broken YAML, so re-supply the space the user has not
    // typed yet when the caret still sits right against the dash.
    insertPrefix: gap.length > 0 ? 'type: ' : ' type: ',
  };
}

/**
 * The caret sits in an empty value slot (`type: ` with nothing after it). That
 * offset is past the end of every node range, so a direct read finds no context
 * at all. Park a sentinel scalar in the slot to give the value a range the caret
 * falls inside; only its position is ever used.
 */
function withValueSentinel(text: string, offset: number, line: string): Rewrite | null {
  const match = EMPTY_VALUE_SLOT.exec(line);
  if (!match) return null;

  const [, upToColon, gap] = match;
  const start = lineStartAt(text, offset);
  if (offset < start + upToColon.length) return null; // caret is on the key, not the slot

  const spacing = gap.length > 0 ? gap : ' ';
  const rewritten = upToColon + spacing + KEY_SENTINEL;

  return {
    text: text.slice(0, start) + rewritten + text.slice(start + line.length),
    offset: start + upToColon.length + spacing.length,
    expect: ['component-type', 'value'],
    insertPrefix: '',
  };
}

// ---------------------------------------------------------------------------
// 1. component names
// ---------------------------------------------------------------------------

function componentNameCandidates(schema: SchemaRoot, insertPrefix: string): CompletionCandidate[] {
  return Object.values(schema.components)
    .map((component) =>
      named(component.name, 'component', shortTypeName(component.className), insertPrefix),
    )
    .sort(byLabel);
}

/**
 * The `type:` values a prototype document can carry — `entity`, `reagent`,
 * `jobIcon`, … — keyed in the schema by exactly that string.
 */
function prototypeNameCandidates(schema: SchemaRoot, insertPrefix: string): CompletionCandidate[] {
  return Object.values(schema.prototypes)
    .filter((prototype) => prototype.yamlType.length > 0)
    .map((prototype) =>
      named(prototype.yamlType, 'prototype', shortTypeName(prototype.className), insertPrefix),
    )
    .sort(byLabel);
}

/** A name candidate, carrying an insert text only when the recovery synthesized `type:`. */
function named(
  label: string,
  kind: 'prototype' | 'component',
  detail: string,
  insertPrefix: string,
): CompletionCandidate {
  return insertPrefix
    ? { label, kind, detail, insertText: `${insertPrefix}${label}` }
    : { label, kind, detail };
}

// ---------------------------------------------------------------------------
// 2–4. field keys (component / nested DataDefinition / prototype)
// ---------------------------------------------------------------------------

function fieldKeyCandidates(
  ctx: CursorContext,
  schema: SchemaRoot,
  needsColon: boolean,
): CompletionCandidate[] {
  const container = containerFields(ctx, schema);
  if (!container) return [];

  const caretKey = ctx.fieldPath[ctx.fieldPath.length - 1];
  const alreadyPresent = new Set(ctx.containerKeys.filter((key) => key !== caretKey));

  return container
    .filter((field) => !alreadyPresent.has(field.tag))
    .map((field) => ({
      label: field.tag,
      kind: 'field' as const,
      detail: fieldDetail(field),
      // The caret line has no `:` yet, so carry one in the insert text and leave
      // the caret on the value slot after it.
      ...(needsColon ? { insertText: `${field.tag}: ` } : {}),
    }))
    .sort(byLabel);
}

// ---------------------------------------------------------------------------
// 5. field values
// ---------------------------------------------------------------------------

/**
 * Values a field will accept, chosen by its declared `fieldKind` rather than by
 * anything about its name. Only the kinds whose whole domain is in the schema
 * can be listed: `boolean`, and the enum-backed `enum` / `flags`. A `protoId`,
 * `resPath` or `entityProtoId` names something declared elsewhere in the fork,
 * which this document does not carry, so those stay empty.
 */
function valueCandidates(ctx: CursorContext, schema: SchemaRoot): CompletionCandidate[] {
  const field = fieldAt(ctx, schema);
  if (!field) return [];

  const { values, detail } = valueChoicesOf(field, schema);
  return values.map((value) => ({ label: value, kind: 'value' as const, detail }));
}

const BOOLEAN_VALUES = ['false', 'true'] as const;

/**
 * The listable domain of a field, read through its list `element` when the field
 * is a sequence of such values. `detail` names the type the values come from.
 */
function valueChoicesOf(
  field: FieldMetadata,
  schema: SchemaRoot,
): { values: readonly string[]; detail: string | undefined } {
  const kind = field.fieldKind === 'list' ? field.element?.kind : field.fieldKind;

  if (kind === 'boolean') return { values: BOOLEAN_VALUES, detail: 'Boolean' };
  if (kind !== 'enum' && kind !== 'flags') return { values: [], detail: undefined };

  const inline = field.enumValues ?? field.element?.enumValues;
  if (inline && inline.length > 0) return { values: [...inline], detail: field.type };

  const ref = field.enumRef ?? field.element?.enumRef;
  if (ref) {
    const detail = shortTypeName(ref);
    if (schema.enums[ref]) return { values: [...schema.enums[ref]], detail };
    // Numeric named constants — the names are what YAML accepts.
    const constants = schema.enumConstants[ref];
    if (constants) return { values: constants.map((entry) => entry.name), detail };
  }
  return { values: [], detail: undefined };
}

// ---------------------------------------------------------------------------
// container resolution — shared by the field-key and field-value paths
// ---------------------------------------------------------------------------

/**
 * One field, addressed the way the cursor context reports it: from the innermost
 * component when the caret is inside one, from the prototype map otherwise.
 * {@link CursorContext} and the walk's registry probe both satisfy it, so the
 * chain is resolved by one function for both.
 */
interface FieldRef {
  readonly component: string | null;
  readonly prototypeType: string | null;
  readonly fieldPath: readonly string[];
  readonly fieldTags: readonly (string | null)[];
}

/** Metadata of the field `ref`'s last key names, or `null` when the chain does not resolve. */
function fieldAt(ref: FieldRef, schema: SchemaRoot): FieldMetadata | null {
  const container = containerFields(ref, schema);
  if (!container || ref.fieldPath.length === 0) return null;

  const leafKey = ref.fieldPath[ref.fieldPath.length - 1];
  return container.find((candidate) => candidate.tag === leafKey) ?? null;
}

/**
 * The field list the caret's key chain lands in: a component's own fields, a
 * prototype's `[Prototype]`-type fields, or — for a deeper chain — the fields of
 * the `[DataDefinition]` each step's key is typed as. `null` when the schema
 * does not know the component / prototype type, or a step is not a
 * DataDefinition-typed field (a plain scalar, list or dictionary has no fixed
 * sub-fields to complete).
 */
function containerFields(ref: FieldRef, schema: SchemaRoot): readonly FieldMetadata[] | null {
  let fields = rootFieldsFor(ref, schema);
  if (!fields) return null;

  // fieldPath ends with the (possibly partial) key under the caret; the keys
  // before it name the container chain to walk into.
  for (let step = 0; step < ref.fieldPath.length - 1; step++) {
    const field = fields.find((candidate) => candidate.tag === ref.fieldPath[step]);
    if (!field) return null;
    const definition = definitionOf(field, ref.fieldTags[step] ?? null, schema);
    if (!definition) return null;
    fields = definition.fields;
  }
  return fields;
}

/**
 * The field list the caret's container chain starts from: the innermost
 * component's fields when the caret is inside a component registry, otherwise
 * the prototype's fields keyed by its `type:`. `null` when the schema does not
 * know that component / prototype type.
 */
function rootFieldsFor(ref: FieldRef, schema: SchemaRoot): readonly FieldMetadata[] | null {
  if (ref.component !== null) {
    return schema.components[ref.component]?.fields ?? null;
  }
  if (ref.prototypeType !== null) {
    return schema.prototypes[ref.prototypeType]?.fields ?? null;
  }
  return null;
}

/**
 * The `[DataDefinition]` one step of a key chain descends into: what the field
 * (or its list element / dictionary value) is declared as — or, when the YAML
 * node carries a `!type:` tag, the concrete member of the union that tag names.
 * The declared type stays the fallback: it is the abstract base, whose fields
 * are the part every member shares.
 */
function definitionOf(
  field: FieldMetadata,
  tag: string | null,
  schema: SchemaRoot,
): DataDefinitionMetadata | null {
  const tagged = tag ? taggedDefinition(tag, declaredTypeName(field), schema) : null;
  if (tagged) return tagged;

  const typeName =
    dataDefinitionTypeName(field) ??
    dataDefinitionTypeName(field.element) ??
    dataDefinitionTypeName(field.value);
  if (!typeName) return null;
  return schema.dataDefinitions[typeName] ?? null;
}

function dataDefinitionTypeName(
  node: Pick<FieldTypeNode, 'isDataDefinition' | 'dataDefinitionType'> | undefined,
): string | undefined {
  if (!node) return undefined;
  return node.isDataDefinition && node.dataDefinitionType ? node.dataDefinitionType : undefined;
}

/** Full type name declared at this step — the union a `!type:` tag is scoped to. */
function declaredTypeName(field: FieldMetadata): string | undefined {
  return field.element?.fullType ?? field.value?.fullType ?? field.fullType;
}

/** `!type:Foo` — how the engine writes "this member of the union" in YAML. */
const TYPE_TAG = /^!type:(.+)$/;

/**
 * The definition a `!type:` tag names. Resolved among the polymorphic members of
 * the declared base first, because bare class names repeat across assemblies
 * (`ThrusterComponent` is two types, Server and Client) and the union the field
 * declares is what tells them apart. Only a base the schema carries no members
 * for falls back to the global by-name index.
 */
function taggedDefinition(
  tag: string,
  baseType: string | undefined,
  schema: SchemaRoot,
): DataDefinitionMetadata | null {
  const name = TYPE_TAG.exec(tag)?.[1];
  if (!name) return null;

  const members = baseType ? schema.polymorphicTypes[baseType] : undefined;
  const member = members?.find((candidate) => shortTypeName(candidate) === name);
  if (member && schema.dataDefinitions[member]) return schema.dataDefinitions[member];

  return definitionsByShortName(schema).get(name) ?? null;
}

/**
 * Definitions indexed by bare class name, for the tags the union lookup misses.
 * A name carried by more than one type indexes to `null`: an ambiguous tag
 * resolves to nothing rather than to the wrong type's fields. Built once per
 * schema — there are ~7k definitions — and kept beside it, not in a module-level
 * cache that would outlive a reloaded schema.
 */
const definitionIndexes = new WeakMap<SchemaRoot, Map<string, DataDefinitionMetadata | null>>();

function definitionsByShortName(schema: SchemaRoot): Map<string, DataDefinitionMetadata | null> {
  const cached = definitionIndexes.get(schema);
  if (cached) return cached;

  const index = new Map<string, DataDefinitionMetadata | null>();
  for (const [fullName, definition] of Object.entries(schema.dataDefinitions)) {
    const shortName = definition.shortName || shortTypeName(fullName);
    index.set(shortName, index.has(shortName) ? null : definition);
  }
  definitionIndexes.set(schema, index);
  return index;
}

function fieldDetail(field: FieldMetadata): string {
  return field.required ? `${field.type} (required)` : field.type;
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

function byLabel(a: CompletionCandidate, b: CompletionCandidate): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/**
 * The bare class name out of a CLR type name, for a one-word signature:
 * `Content.Shared.Actions.Components.ItemActionIconStyle` -> `ItemActionIconStyle`.
 *
 * Generic types arrive assembly-qualified — ``System.Nullable`1[[Content.Shared.
 * Inventory.SlotFlags, Content.Shared, Version=…]]`` — where the interesting name
 * is the first type argument, not the outer wrapper, and splitting on the last
 * `.` alone lands in the middle of `PublicKeyToken=null]]`.
 */
function shortTypeName(fullName: string): string {
  const genericArgs = fullName.indexOf('[[');
  const name = genericArgs === -1 ? fullName : fullName.slice(genericArgs + 2).split(',')[0];
  const lastDot = name.lastIndexOf('.');
  const bare = (lastDot === -1 ? name : name.slice(lastDot + 1)).split('`')[0];
  return bare || fullName;
}
