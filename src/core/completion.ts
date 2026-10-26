/**
 * Autocomplete candidates for prototype YAML (spec #20, "Текстовые провайдеры";
 * issue #27). Pure core: text + offset + schema snapshot in, a list of
 * candidates as plain data out. The host adapter ({@link file://../host/text-providers.ts})
 * wraps each candidate in a `vscode.CompletionItem`; nothing here knows about
 * VS Code.
 *
 * The cursor context is entirely {@link cursorContextAt}'s job (issue #24) — this
 * module never walks the YAML tree itself. From that context it decides which of
 * seven lists the caret is asking for:
 *
 *   1. component names   — on the `type:` value slot of a component-registry entry;
 *   2. component fields  — on a key inside a component block;
 *   3. DataDefinition fields — on a key inside a nested `[DataDefinition]` value;
 *   4. prototype fields  — on a key at the top level of the prototype, keyed by
 *      its `[Prototype]` type (`entity` -> `EntityPrototype`, `reagent` ->
 *      `ReagentPrototype`, …);
 *   5. field values      — on a value slot, for the field kinds whose whole
 *      domain the schema carries: `boolean`, and the enum-backed `enum`/`flags`
 *      — plus prototype ids (`protoId`/`entityProtoId`, and `parent:`), whose
 *      domain is the prototype index rather than the schema (issue #33);
 *   6. prototype types   — on the `type:` value slot of the prototype itself,
 *      one level out from (1);
 *   7. union members     — on a `!type:` tag, or where one can still go (a bare
 *      `- ` in a list, an empty value slot), when the declared type is a key of
 *      the schema's `polymorphicTypes`: the short class names the engine
 *      accepts after `!type:` (issue #43).
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
 * one writes the key the document is still missing. A bare `- ` in a list of
 * prototype ids is the exception: it is first read as a scalar item
 * (`<indent>- <sentinel>`), and only falls back to the `type:` rewrite when the
 * list it sits in is not one of ids.
 */

import {
  cursorContextAt,
  parsePrototypeFile,
  TYPE_TAG_PREFIX,
  type CursorContext,
  type PrototypeFile,
} from './prototype-yaml';
import type { PrototypeIndexView } from './prototype-index';
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
  readonly kind: 'prototype' | 'component' | 'field' | 'value' | 'id' | 'type';
  /**
   * Short right-aligned signature: a declared type, a class name, an enum type,
   * or — for an id — its prototype kind, `(abstract)` when it is one. A union
   * member's is its full type name, the one thing a bare class name can repeat.
   */
  readonly detail?: string;
  /**
   * Text to insert when it differs from {@link label} — where the document is
   * still missing syntax the candidate needs: the `type:` key on a bare `- `
   * (picking `Clothing` writes `type: Clothing`), a field key's colon, or a union
   * member's `!type:` tag.
   */
  readonly insertText?: string;
  /**
   * `[start, end)` offsets to replace instead of the word at the caret — set on a
   * `!type:` tag already in the text, whose `!` and `:` are not word characters,
   * so the whole tag is swapped for {@link insertText}.
   */
  readonly range?: readonly [number, number];
}

/**
 * Candidates for the caret at `offset` in `text`, given the loaded `schema` and
 * the prototype `index`. Empty when the caret is not on one of the completion
 * points, the schema (or, for an id, the index) has nothing to offer there, or
 * the text cannot be parsed even after the bare-key recovery below. Ids need an
 * index that is ready; without one their slot stays empty.
 */
export function completionsAt(
  text: string,
  offset: number,
  schema: SchemaRoot,
  index?: PrototypeIndexView,
): CompletionCandidate[] {
  const resolved = resolveCursor(text, offset, schema);
  if (!resolved) return [];
  const { ctx, insertPrefix, keyNeedsColon } = resolved;

  switch (ctx.token.kind) {
    case 'type-tag':
      return memberCandidates(polymorphicBaseOf(slotAt(ctx, schema), schema, true), schema, {
        insertPrefix,
        // A tag the recovery wrote has no span in the document to replace.
        range: resolved.rewritten ? undefined : ctx.token.range,
      });
    case 'component-type':
      return componentNameCandidates(schema, insertPrefix);
    case 'key':
      return containerFields(ctx, schema)
        ? fieldKeyCandidates(ctx, schema, keyNeedsColon)
        : dictionaryKeyCandidates(ctx, schema, index, keyNeedsColon);
    case 'value':
      if (onPrototypeTypeSlot(ctx)) return prototypeNameCandidates(schema, insertPrefix);
      if (resolved.openValueSlot) {
        const base = polymorphicBaseOf(slotAt(ctx, schema), schema, false);
        if (base) return memberCandidates(base, schema, { insertPrefix });
      }
      return valueCandidates(ctx, schema, index, insertPrefix);
    default:
      return [];
  }
}

/**
 * Whether the host should reopen the suggestion list after a deletion left the
 * caret at `offset`. VS Code opens it on typing but never on Backspace, so
 * going back into a wrong value and deleting part of it shows nothing.
 *
 * Reopens only where the caret still touches a partial word, or sits in a value
 * slot the deletion emptied (`type: `) — never on a blank line, so deleting
 * whole lines does not keep popping the list — and only where there is
 * something to offer.
 */
export function reopensSuggestAfterDeletion(
  text: string,
  offset: number,
  schema: SchemaRoot,
  index?: PrototypeIndexView,
): boolean {
  const before = text.slice(lineStartAt(text, offset), offset);
  if (!PARTIAL_WORD.test(before) && !EMPTIED_VALUE.test(before) && !EMPTIED_TAG.test(before)) return false;
  return completionsAt(text, offset, schema, index).length > 0;
}

/**
 * Whether the host should open the suggestion list after Enter left the caret at
 * `offset`. VS Code opens it on typing, never on a new line, so after finishing
 * `field: value` the next field had to be started by hand before anything
 * showed. Opens only on a line that is still blank — Enter that split a line
 * leaves text there — and only where there is something to offer.
 */
export function opensSuggestOnNewLine(
  text: string,
  offset: number,
  schema: SchemaRoot,
  index?: PrototypeIndexView,
): boolean {
  if (!BLANK_LINE.test(lineAround(text, offset))) return false;
  return completionsAt(text, offset, schema, index).length > 0;
}

/** A line that ends in the middle of a word — not on whitespace, `:` or `-`. */
const PARTIAL_WORD = /[^\s:\-#,[\]{}'"]$/;

/** A line that ends in an empty value slot: `key:` plus at least one space. */
const EMPTIED_VALUE = /:[ \t]+$/;

/** A line that ends in a `!type:` tag with its member name deleted. */
const EMPTIED_TAG = /!type:$/;

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
  /** The context was read from a rewritten caret line, so its offsets are not the document's. */
  readonly rewritten: boolean;
  /**
   * The caret sits after a `key:` with nothing written behind it on the line —
   * where a `!type:` tag may still go, whether or not a block map follows below.
   */
  readonly openValueSlot: boolean;
}

/**
 * The cursor context for `offset`, applying the mid-edit recovery from this
 * module's header. `null` only when the text cannot be parsed at all.
 *
 * A caret line with no `:` is always a key-or-item in progress, so it is
 * rewritten even when the document happens to parse — that is the case `yaml`
 * silently reads as the previous line's scalar. A line that does have its `:`
 * needs help when the caret sits in an empty value slot: past the end of every
 * node range, the direct read comes back with nothing — or, when the next line
 * starts another item of an enclosing sequence (`  - type: Sprite`), with the
 * field that sequence belongs to, because `yaml` closes the caret's map before
 * the caret. So an empty slot is always rewritten first, and the direct read
 * only stands when the rewrite does not parse.
 */
function resolveCursor(text: string, offset: number, schema: SchemaRoot): ResolvedCursor | null {
  const direct = parsePrototypeFile(text);
  const directCtx = direct.ok ? contextAt(direct, offset, schema) : null;
  const line = lineAround(text, offset);
  const keyNeedsColon = !line.includes(':');
  const openValueSlot = onOpenValueSlot(text, offset, line);

  // A tag in the text is read where it is: `- !type:` also looks like an empty
  // value slot to the rewrites below, and the sentinel they park would land
  // past the tag.
  if (directCtx?.token.kind === 'type-tag') {
    return { ctx: directCtx, insertPrefix: '', keyNeedsColon, rewritten: false, openValueSlot: false };
  }

  const rewrites = keyNeedsColon
    ? [
        withScalarItem(text, offset, line),
        withTagItem(text, offset, line),
        withTypeKey(text, offset, line),
        withSentinelKey(text, offset, line),
      ]
    : [withValueSentinel(text, offset, line)];

  for (const rewrite of rewrites) {
    if (!rewrite) continue;
    const retry = parsePrototypeFile(rewrite.text);
    if (!retry.ok) continue;
    const ctx = contextAt(retry, rewrite.offset, schema);
    if (rewrite.expect.includes(ctx.token.kind) && (rewrite.accept?.(ctx, schema) ?? true)) {
      return { ctx, insertPrefix: rewrite.insertPrefix, keyNeedsColon, rewritten: true, openValueSlot };
    }
  }

  // The slot rewrite fails to parse where a block already follows below
  // (`sound:` over its `path:`); the caret right against the colon still needs
  // its space.
  const againstColon = openValueSlot && text[offset - 1] === ':';
  return directCtx
    ? { ctx: directCtx, insertPrefix: againstColon ? ' ' : '', keyNeedsColon, rewritten: false, openValueSlot }
    : null;
}

/** True when the caret is past the colon of a `key:` that has nothing after it on the line. */
function onOpenValueSlot(text: string, offset: number, line: string): boolean {
  const match = EMPTY_VALUE_SLOT.exec(line);
  return !!match && offset >= lineStartAt(text, offset) + match[1].length;
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
 * So the answer is the declared kind of whatever slot the chain lands on — a
 * field, or a dictionary entry — the same lookup the field candidates use,
 * never a name match.
 */
export function contextAt(file: PrototypeFile, offset: number, schema: SchemaRoot): CursorContext {
  return cursorContextAt(file, offset, {
    isComponentRegistry: (site) => slotAt(site, schema)?.node.kind === COMPONENT_REGISTRY_KIND,
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
  /** A further check on where the caret landed, for rewrites that only fit some fields. */
  readonly accept?: (ctx: CursorContext, schema: SchemaRoot) => boolean;
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
 * A bare `- ` in a list of prototype ids (`parent:`, `List<EntProtoId>`, …) is
 * the start of one more id. Rewrite it to `<indent>- <sentinel>` and accept the
 * landing only when the list's field names prototypes — anywhere else a bare
 * `- ` is a map item, and {@link withTypeKey} reads it.
 */
function withScalarItem(text: string, offset: number, line: string): Rewrite | null {
  const match = SEQ_ITEM_START.exec(line);
  if (!match) return null;

  const [, indent, gap] = match;
  const start = lineStartAt(text, offset);
  const rewritten = `${indent}- ${KEY_SENTINEL}`;

  return {
    text: text.slice(0, start) + rewritten + text.slice(start + line.length),
    offset: start + rewritten.length - KEY_SENTINEL.length,
    expect: ['value'],
    accept: (ctx, schema) => protoRefKindAt(ctx, schema) !== null,
    // `-FireAxe` would be a scalar, not an item: re-supply the space.
    insertPrefix: gap.length > 0 ? '' : ' ',
  };
}

/**
 * A bare `- ` in a list of a union type (`effects:` of `CEEntityEffect`s) is the
 * start of one more tagged member. Rewrite it to `<indent>- !type:` and accept
 * the landing only when the list's element is polymorphic — anywhere else a
 * bare `- ` is a component, a prototype or an id, read by the neighbouring
 * rewrites. The tag it writes is not in the document, so candidates carry it.
 */
function withTagItem(text: string, offset: number, line: string): Rewrite | null {
  const item = SEQ_ITEM_START.exec(line);
  // An empty line between two items is a new item whose dash is not typed yet.
  // Only between: SS14 writes a list's dashes at its key's indent, so a blank
  // line after the last item is just as much the next key of the enclosing map.
  const blank = item ? null : BLANK_LINE.exec(line);
  if (!item && !(blank && nextLineIsItemAt(text, offset, blank[1]))) return null;

  const indent = (item ?? blank)![1];
  const start = lineStartAt(text, offset);
  const rewritten = `${indent}- ${TYPE_TAG_PREFIX}`;

  return {
    text: text.slice(0, start) + rewritten + text.slice(start + line.length),
    offset: start + rewritten.length,
    expect: ['type-tag'],
    accept: (ctx, schema) => polymorphicBaseOf(slotAt(ctx, schema), schema, true) !== null,
    // `-!type:X` would be a scalar, not an item: re-supply the space — and on a
    // blank line, the dash too.
    insertPrefix: blank ? '- ' : item![2].length > 0 ? '' : ' ',
  };
}

/** A line of indentation only. */
const BLANK_LINE = /^([ \t]*)$/;

/** Whether the next non-blank line after the caret's is a `- ` item at exactly `indent`. */
function nextLineIsItemAt(text: string, offset: number, indent: string): boolean {
  const rest = text.slice(text.indexOf('\n', offset) + 1 || text.length).split('\n');
  const next = rest.find((candidate) => candidate.trim().length > 0);
  return next !== undefined && next.startsWith(`${indent}-`) && !/^[ \t]/.test(next.slice(indent.length));
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
 * falls inside; only its position is ever used. A caret right against the colon
 * (the `:` trigger fired) gets the space re-supplied: `parent:Base` is one
 * scalar, not a key and a value.
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
    insertPrefix: offset === start + upToColon.length ? ' ' : '',
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

  const alreadyPresent = siblingKeys(ctx);

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

/**
 * A key inside a dictionary is data of the dictionary's key type, so it takes
 * that type's values — prototype ids for `Dictionary<ProtoId<T>, …>`
 * (`damage.types`), enum members for an enum-keyed one — minus the keys already
 * written, each carrying its colon when the line has none yet.
 */
function dictionaryKeyCandidates(
  ctx: CursorContext,
  schema: SchemaRoot,
  index: PrototypeIndexView | undefined,
  needsColon: boolean,
): CompletionCandidate[] {
  const slot = keySlotAt(ctx, schema);
  if (!slot) return [];

  const alreadyPresent = siblingKeys(ctx);
  return slotCandidates(slot, ctx, schema, index, '')
    .filter((candidate) => !alreadyPresent.has(candidate.label))
    .map((candidate) => (needsColon ? { ...candidate, insertText: `${candidate.label}: ` } : candidate));
}

/** Keys already written beside the caret's key, which a key completion must not offer again. */
function siblingKeys(ctx: CursorContext): Set<string> {
  const caretKey = ctx.fieldPath[ctx.fieldPath.length - 1];
  return new Set(ctx.containerKeys.filter((key) => key !== caretKey));
}

// ---------------------------------------------------------------------------
// 5. field values
// ---------------------------------------------------------------------------

/**
 * Values a field will accept, chosen by its declared `fieldKind` rather than by
 * anything about its name. From the schema: the kinds whose whole domain it
 * carries — `boolean`, and the enum-backed `enum` / `flags`. From the index: the
 * ids a prototype reference ({@link protoRefKind}) may name. A `resPath` names a
 * file, which neither carries, so it stays empty.
 */
function valueCandidates(
  ctx: CursorContext,
  schema: SchemaRoot,
  index: PrototypeIndexView | undefined,
  insertPrefix: string,
): CompletionCandidate[] {
  const slot = slotAt(ctx, schema);
  return slot ? slotCandidates(slot, ctx, schema, index, insertPrefix) : [];
}

/** What a slot accepts: prototype ids when it references prototypes, else its listable values. */
function slotCandidates(
  slot: Slot,
  ctx: CursorContext,
  schema: SchemaRoot,
  index: PrototypeIndexView | undefined,
  insertPrefix: string,
): CompletionCandidate[] {
  const refKind = protoRefKind(slot, ctx.prototypeType);
  if (refKind !== null) return idCandidates(refKind, index, insertPrefix);

  const { values, detail } = valueChoicesOf(slot, schema);
  return values.map((value) => ({
    label: value,
    kind: 'value' as const,
    detail,
    ...(insertPrefix ? { insertText: `${insertPrefix}${value}` } : {}),
  }));
}

const BOOLEAN_VALUES = ['false', 'true'] as const;

/**
 * The prototype kind a slot's value names, or `null` when it names none:
 *
 *   - `parent:` (`isParent`) — the prototype's own kind: an entity inherits
 *     from entities, a reagent from reagents;
 *   - `EntProtoId` — always `entity`;
 *   - `ProtoId<T>` — `T`'s YAML type, which the CLI emits as `protoTypeArg`.
 *
 * A list is read through its element, so `List<EntProtoId>` and a `parent:`
 * list answer the same as a single value.
 */
function protoRefKind(slot: Slot, prototypeType: string | null): string | null {
  if (slot.field?.isParent) return prototypeType;

  const item = itemOf(slot.node);
  if (item.kind === 'entityProtoId') return ENTITY_KIND;
  if (item.kind === 'protoId') return item.protoTypeArg ?? null;
  return null;
}

/**
 * {@link protoRefKind} of what the caret is on, or `null`: a value's slot, or —
 * on a key — the key type of the dictionary it sits in.
 */
export function protoRefKindAt(ctx: CursorContext, schema: SchemaRoot): string | null {
  const slot =
    ctx.token.kind === 'value' ? slotAt(ctx, schema) : ctx.token.kind === 'key' ? keySlotAt(ctx, schema) : null;
  return slot ? protoRefKind(slot, ctx.prototypeType) : null;
}

/** The `type:` of `EntityPrototype` — what every `EntProtoId` names. */
const ENTITY_KIND = 'entity';

/**
 * Every id of `kind` in the index, abstract ones included — they are exactly
 * what `parent:` wants. A duplicated id is listed once. Empty until the index
 * is ready.
 */
function idCandidates(
  kind: string,
  index: PrototypeIndexView | undefined,
  insertPrefix: string,
): CompletionCandidate[] {
  if (!index?.ready) return [];

  const byId = new Map<string, CompletionCandidate>();
  for (const record of index.all()) {
    if (record.kind !== kind || byId.has(record.id)) continue;
    const detail = record.abstract ? `${kind} (abstract)` : kind;
    byId.set(
      record.id,
      insertPrefix
        ? { label: record.id, kind: 'id', detail, insertText: `${insertPrefix}${record.id}` }
        : { label: record.id, kind: 'id', detail },
    );
  }
  return [...byId.values()].sort(byLabel);
}

/**
 * The listable domain of a slot, read through its list `element` when the slot
 * is a sequence of such values. `detail` names the type the values come from.
 */
function valueChoicesOf(
  slot: Slot,
  schema: SchemaRoot,
): { values: readonly string[]; detail: string | undefined } {
  const item = itemOf(slot.node);

  if (item.kind === 'boolean') return { values: BOOLEAN_VALUES, detail: 'Boolean' };
  if (item.kind !== 'enum' && item.kind !== 'flags') return { values: [], detail: undefined };

  const inline = item.enumValues;
  if (inline && inline.length > 0) {
    return { values: [...inline], detail: slot.field?.type ?? shortTypeName(item.fullType ?? '') };
  }

  const ref = item.enumRef;
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
// 7. union members
// ---------------------------------------------------------------------------

/**
 * The polymorphic base a slot's value is declared as — a key of the schema's
 * `polymorphicTypes` — or `null`. A tag can sit on a list item as well as on the
 * field itself, so `throughList` reads a list through its element; an empty
 * `key:` slot is the field's own value, and a list there takes items, not a tag.
 */
function polymorphicBaseOf(slot: Slot | null, schema: SchemaRoot, throughList: boolean): string | null {
  if (!slot) return null;
  const node = throughList ? itemOf(slot.node) : slot.node;
  const base = node.fullType;
  return base && schema.polymorphicTypes[base]?.length ? base : null;
}

/**
 * The full name of the union member a written `!type:` tag picks — the member of
 * the slot's declared base whose short name the tag spells (go-to-definition,
 * issue #31). `null` off a tag, on an empty one, outside a polymorphic slot, or
 * for a name the base has no member by. A nested member matches by its own name
 * (`CycleModeEvent`) as well as with its outer class (`SharedGunSystem+CycleModeEvent`).
 */
export function typeTagMemberAt(ctx: CursorContext, schema: SchemaRoot): string | null {
  if (ctx.token.kind !== 'type-tag' || ctx.token.text === null) return null;
  const base = polymorphicBaseOf(slotAt(ctx, schema), schema, true);
  if (!base) return null;

  const name = ctx.token.text;
  return (
    schema.polymorphicTypes[base].find((member) => {
      const short = shortTypeName(member);
      return short === name || short.slice(short.lastIndexOf('+') + 1) === name;
    }) ?? null
  );
}

/**
 * The concrete members of `base` as `!type:` candidates: the short class name the
 * engine resolves the tag by, the full name as its signature. The CLI lists only
 * non-abstract implementors, so every one is a legal pick. Each inserts the
 * whole tag — over `range` when one is written already.
 */
function memberCandidates(
  base: string | null,
  schema: SchemaRoot,
  where: { readonly insertPrefix: string; readonly range?: readonly [number, number] },
): CompletionCandidate[] {
  if (!base) return [];
  return schema.polymorphicTypes[base]
    .map((member): CompletionCandidate => {
      const label = shortTypeName(member);
      const insertText = `${where.insertPrefix}${TYPE_TAG_PREFIX}${label}`;
      return where.range
        ? { label, kind: 'type', detail: member, insertText, range: where.range }
        : { label, kind: 'type', detail: member, insertText };
    })
    .sort((a, b) => byLabel(a, b) || ((a.detail ?? '') < (b.detail ?? '') ? -1 : 1));
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

/**
 * One level of a declared type, whether it is a whole field or a node inside one
 * (a list's element, a dictionary's value). A field carries its kind as
 * `fieldKind`; {@link nodeOf} lifts it into this shape.
 */
type TypeNode = Omit<FieldTypeNode, 'tupleElements'>;

function nodeOf(field: FieldMetadata): TypeNode {
  return { ...field, kind: field.fieldKind };
}

/** A list's (or nested list's) item type; any other node is its own item. */
function itemOf(node: TypeNode): TypeNode {
  let item = node;
  while (item.kind === 'list' && item.element) item = item.element;
  return item;
}

/** `FieldTypeNode.kind` the CLI emits for a dictionary. */
const DICTIONARY_KIND = 'map';

/**
 * What one key of the chain names: a declared field — or, below a dictionary,
 * one of its entries, whose key is data and whose type is the dictionary's value
 * type. `field` is `null` for such an entry.
 */
interface Slot {
  readonly field: FieldMetadata | null;
  readonly node: TypeNode;
}

/**
 * Where the chain walk stands between two keys: in a field list (a component, a
 * prototype or a `[DataDefinition]`), where the next key is a field name; or
 * inside a dictionary, where the next key is an entry's key.
 */
type Scope =
  | { readonly fields: readonly FieldMetadata[] }
  | { readonly dictionary: TypeNode };

/** The slot `ref`'s last key names, or `null` when the chain does not resolve. */
function slotAt(ref: FieldRef, schema: SchemaRoot): Slot | null {
  if (ref.fieldPath.length === 0) return null;
  const scope = scopeAt(ref, schema);
  return scope ? slotIn(scope, ref.fieldPath[ref.fieldPath.length - 1]) : null;
}

/**
 * The key type of the dictionary `ref`'s last key sits in, or `null` when that
 * key is a field name rather than a dictionary key.
 */
function keySlotAt(ref: FieldRef, schema: SchemaRoot): Slot | null {
  const scope = scopeAt(ref, schema);
  const key = scope && 'dictionary' in scope ? scope.dictionary.key : undefined;
  return key ? { field: null, node: key } : null;
}

/**
 * The field list the caret's key chain lands in: a component's own fields, a
 * prototype's `[Prototype]`-type fields, or — for a deeper chain — the fields of
 * the `[DataDefinition]` each step's key is typed as. `null` when the schema
 * does not know the component / prototype type, a step is not DataDefinition-
 * typed (a plain scalar or list has no fixed sub-fields to complete), or the
 * caret's key is a dictionary key, which is data, not a field name.
 */
function containerFields(ref: FieldRef, schema: SchemaRoot): readonly FieldMetadata[] | null {
  const scope = scopeAt(ref, schema);
  return scope && 'fields' in scope ? scope.fields : null;
}

/**
 * The scope the chain's last key sits in. `fieldPath` ends with the (possibly
 * partial) key under the caret; the keys before it name the containers to walk
 * into — fields, and the entry keys of any dictionaries on the way.
 */
function scopeAt(ref: FieldRef, schema: SchemaRoot): Scope | null {
  const root = rootFieldsFor(ref, schema);
  if (!root) return null;

  let scope: Scope = { fields: root };
  for (let step = 0; step < ref.fieldPath.length - 1; step++) {
    const slot = slotIn(scope, ref.fieldPath[step]);
    if (!slot) return null;
    const inner = scopeUnder(slot.node, ref.fieldTags[step] ?? null, schema);
    if (!inner) return null;
    scope = inner;
  }
  return scope;
}

function slotIn(scope: Scope, key: string): Slot | null {
  if ('dictionary' in scope) {
    const value = scope.dictionary.value;
    return value ? { field: null, node: value } : null;
  }
  const field = scope.fields.find((candidate) => candidate.tag === key);
  return field ? { field, node: nodeOf(field) } : null;
}

/**
 * The scope a slot's value opens: a dictionary's entries, or the fields of the
 * `[DataDefinition]` it (or its list item) is typed as. `null` for anything
 * with no keys of its own.
 */
function scopeUnder(node: TypeNode, tag: string | null, schema: SchemaRoot): Scope | null {
  const item = itemOf(node);
  if (item.kind === DICTIONARY_KIND) return { dictionary: item };
  const definition = definitionOf(item, tag, schema);
  return definition ? { fields: definition.fields } : null;
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
 * The `[DataDefinition]` one step of a key chain descends into: what the item
 * type is declared as — or, when the YAML node carries a `!type:` tag, the
 * concrete member of the union that tag names. The declared type stays the
 * fallback: it is the abstract base, whose fields are the part every member
 * shares.
 */
function definitionOf(
  item: TypeNode,
  tag: string | null,
  schema: SchemaRoot,
): DataDefinitionMetadata | null {
  const tagged = tag ? taggedDefinition(tag, item.fullType, schema) : null;
  if (tagged) return tagged;

  if (!item.isDataDefinition || !item.dataDefinitionType) return null;
  return schema.dataDefinitions[item.dataDefinitionType] ?? null;
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
