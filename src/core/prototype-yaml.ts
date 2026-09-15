/**
 * Prototype-file YAML core (spec #20, "Парсинг YAML" and "Хирургические правки";
 * issue #24). Pure and VS-Code-free: text in, plain data out.
 *
 * It answers the three questions every editing surface keeps asking about a
 * prototype file, and shares one path resolver between them:
 *
 *   1. path -> range  ({@link resolveField}): where in the text is the field at
 *      `{ entityIndex, component, fieldPath }` — an exact value range, or the
 *      container plus the missing key tail when the field is only inherited.
 *   2. offset -> context  ({@link cursorContextAt}): which prototype, component
 *      and field does an offset fall in, and is it on a key, a value, or the
 *      `type:` slot of a component-registry entry. Which sequence-valued fields
 *      are registries is the caller's to say ({@link CursorContextOptions}) —
 *      `ComponentRegistry` is a declared field type, and only a schema knows it.
 *   3. path -> surgical edit  ({@link replaceScalarValue}, {@link replaceBlockScalarValue},
 *      {@link insertField}, {@link insertComponent}, {@link deleteAt}): one
 *      `{ range, newText }` splice that lands the change without re-serialising
 *      the document — a straight port of `prototype/prototype-surgical-edits`.
 *
 * Parsing rules, straight from the spec:
 *   - Strip a leading U+FEFF before parsing. Without it `yaml`@eemeli yields a
 *     document full of errors for ~9% of real fork files, losing them silently.
 *   - `yaml` (eemeli) with `keepSourceTokens: true`, `strict: false`, and a
 *     `LineCounter` for offset -> line/col. Positions here come from the AST
 *     (`node.range`); `keepSourceTokens` is pinned by the spec — the deletion
 *     edits read the CST (`node.srcToken`) for the exact marker offset and
 *     comment ownership of a list/map item.
 *   - No incremental parser: re-parse the whole document on every edit.
 *   - Any `doc.errors` => the file is "invalid" as a whole; callers get an error
 *     flag, never a partial tree.
 *
 * The parsed tree never leaves this module — {@link parsePrototypeFile} returns
 * an opaque handle and the AST is held in a side table. Tests see only offsets,
 * ranges, strings and enums, so they cannot grow a dependency on node shape.
 */

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  Scalar,
  type Alias,
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Absolute UTF-16 offsets into the parsed (BOM-stripped) text: `[start, valueEnd, nodeEnd]`. */
export type NodeRange = readonly [start: number, valueEnd: number, nodeEnd: number];

export interface TextPosition {
  /** 0-based line. */
  readonly line: number;
  /** 0-based UTF-16 column. */
  readonly character: number;
}

export interface PrototypeParseError {
  readonly ok: false;
  readonly hadBom: boolean;
  /** `yaml`@eemeli parse-error messages, in source order. Never empty. */
  readonly errors: readonly string[];
}

/**
 * Opaque handle to a successfully parsed prototype file; the AST lives in a side
 * table keyed by this object. "entity" is the donor term (`prototype/*`, spec
 * #24) for one item of the top-level prototype sequence, whatever its `type:` —
 * `entity`, `jobIcon`, `demiplaneModifier` … — not only `type: entity`.
 */
export interface PrototypeFile {
  readonly ok: true;
  readonly hadBom: boolean;
  /** The text that was actually parsed: the input minus any leading U+FEFF. */
  readonly text: string;
  /** Number of YAML documents in the stream. A prototype file is normally 1. */
  readonly documentCount: number;
  /** Number of prototypes: length of the first document's top-level block sequence. */
  readonly entityCount: number;
}

export type ParseResult = PrototypeFile | PrototypeParseError;

/** Address of a single field, mirroring `prototype/prototype-surgical-edits`. */
export interface FieldAddress {
  /** Positional index into the top-level prototype sequence (donor term: entity index). */
  readonly entityIndex: number;
  /**
   * Value of a component's `type:` key (never a list index — the engine keeps it
   * unique). Omit to address a field on the prototype map itself (e.g. `parent`).
   */
  readonly component?: string;
  /** Key chain from the container down to the field, any depth. May be empty. */
  readonly fieldPath: readonly string[];
}

export interface ResolvedField {
  /** Full node range `[start, valueEnd, nodeEnd]`. */
  readonly range: NodeRange;
  /** `[start, valueEnd]` — value text only: no trailing whitespace, comment or tag. */
  readonly valueRange: readonly [number, number];
  readonly kind: 'scalar' | 'block-scalar' | 'map' | 'seq' | 'alias' | 'null';
  /** Anchor name when the value carries `&name`; the `&name` marker is outside `valueRange`. */
  readonly anchor?: string;
  /** Target name when the value is `*name`. */
  readonly alias?: string;
  /** Verbatim tag when present, e.g. `!type:PhysShapeAabb`; the tag is outside `valueRange`. */
  readonly tag?: string;
}

export interface MissingField {
  /**
   * Tail of `fieldPath` that is absent from the text, walking only through maps.
   * With `containerRange` pointing at a map (the usual case):
   * `length === 1` — only the leaf key is missing (materialise one key);
   * `length > 1` — an intermediate container chain is missing too.
   * If the walk hit a non-map (a scalar or sequence stands where a map was
   * expected), this is the untraversed remainder and `containerRange` is that
   * non-map node — the caller cannot materialise a key into it.
   */
  readonly missingPath: readonly string[];
  /** Range of the deepest container that does exist in the text — the anchor for a materialising edit. */
  readonly containerRange: NodeRange;
}

export type FieldResolution =
  | { readonly outcome: 'entity-not-found' }
  | { readonly outcome: 'component-not-found' }
  | { readonly outcome: 'resolved'; readonly field: ResolvedField }
  | { readonly outcome: 'missing'; readonly missing: MissingField };

export type CursorToken =
  | { readonly kind: 'key'; readonly name: string }
  | { readonly kind: 'value' }
  /** On the `type:` value slot of a `components:` entry (the component-name completion point). */
  | { readonly kind: 'component-type'; readonly text: string | null }
  | { readonly kind: 'none' };

export interface CursorContext {
  /** Index of the prototype the offset falls in, or `null` if it is between/outside prototypes. */
  readonly entityIndex: number | null;
  /** That prototype's top-level `type:` value (e.g. `entity`, `jobIcon`), or `null`. */
  readonly prototypeType: string | null;
  /**
   * `type:` value of the innermost component the offset is inside, else `null`.
   * Component registries nest (a component's own registry field holds components
   * that may declare one in turn), and the innermost is what {@link fieldPath}
   * is addressed from.
   */
  readonly component: string | null;
  /**
   * Key chain to the field under the offset, including the field itself, counted
   * from {@link component} when the offset is inside one and from the prototype
   * map otherwise. Sequence steps carry no key: every item of a sequence has the
   * same declared type, so an index would add nothing a consumer can look up.
   * Empty when on none.
   */
  readonly fieldPath: readonly string[];
  /**
   * The `!type:` tag the walk descended through at each step, aligned 1:1 with
   * {@link fieldPath} and `null` where the node carried none. A tag is what picks
   * one concrete `[DataDefinition]` out of a union, so a consumer resolving the
   * chain against a schema needs it alongside the keys.
   */
  readonly fieldTags: readonly (string | null)[];
  /**
   * Keys already written in the block map the offset sits in — the map that
   * directly holds `fieldPath`'s last key, or the innermost map the offset is
   * inside. Lets a field-name completion drop siblings that are already present
   * without re-parsing the document. Empty when the offset is not inside a map.
   */
  readonly containerKeys: readonly string[];
  readonly token: CursorToken;
  /** Set when the value node under the offset carries `&name`. */
  readonly anchor?: string;
  /** Set when the value node under the offset is `*name`. */
  readonly alias?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Internals {
  readonly text: string;
  readonly root: Node | null;
  readonly lineCounter: LineCounter;
}

const internals = new WeakMap<PrototypeFile, Internals>();

const BOM = 0xfeff;

/**
 * Parse a prototype file's text. Strips a leading U+FEFF first (recording it in
 * `hadBom`), then parses the whole stream. Any parse error makes the file
 * invalid as a whole — {@link PrototypeParseError} with every message, no
 * partial tree. On success the AST is stashed in a side table keyed by the
 * returned handle; {@link resolveField} / {@link cursorContextAt} / {@link positionAt}
 * read it from there.
 */
export function parsePrototypeFile(rawText: string): ParseResult {
  const hadBom = rawText.charCodeAt(0) === BOM;
  const text = hadBom ? rawText.slice(1) : rawText;

  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, {
    lineCounter,
    keepSourceTokens: true,
    strict: false,
  });

  const errors = docs.flatMap((doc) => doc.errors).map((err) => err.message);
  if (errors.length > 0) {
    return { ok: false, hadBom, errors };
  }

  const root = docs[0]?.contents ?? null;
  const entityCount = isSeq(root) ? root.items.length : 0;

  const file: PrototypeFile = {
    ok: true,
    hadBom,
    text,
    documentCount: docs.length,
    entityCount,
  };
  internals.set(file, { text, root, lineCounter });
  return file;
}

function must(file: PrototypeFile): Internals {
  const found = internals.get(file);
  if (!found) {
    throw new Error('PrototypeFile was not produced by parsePrototypeFile()');
  }
  return found;
}

/** Convert an absolute offset into a 0-based `{ line, character }`. */
export function positionAt(file: PrototypeFile, offset: number): TextPosition {
  const { line, col } = must(file).lineCounter.linePos(offset);
  return { line: line - 1, character: col - 1 };
}

// ---------------------------------------------------------------------------
// AST helpers (module-private — never surfaced)
// ---------------------------------------------------------------------------

const EMPTY_RANGE: NodeRange = [0, 0, 0];

function rangeOf(node: Node | null | undefined): NodeRange {
  const range = node?.range;
  return range ? [range[0], range[1], range[2]] : EMPTY_RANGE;
}

/** String form of a scalar key or value; `undefined` for non-scalars and `null` scalars. */
function scalarString(node: unknown): string | undefined {
  if (!isScalar(node)) return undefined;
  const value = (node as Scalar).value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function findPair(map: YAMLMap, key: string): Pair | null {
  for (const pair of map.items) {
    if (scalarString(pair.key) === key) return pair as Pair;
  }
  return null;
}

/** Scalar-key names of a block map, in source order; non-scalar keys are skipped. */
function keysOf(map: YAMLMap): string[] {
  const keys: string[] = [];
  for (const pair of map.items) {
    const key = scalarString(pair.key);
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

function mapGet(map: YAMLMap, key: string): Node | null {
  return (findPair(map, key)?.value as Node | undefined) ?? null;
}

/** `components:` entry whose `type:` value is `type` — the engine keeps it unique. */
function isComponentOfType(item: unknown, type: string): boolean {
  return isMap(item) && scalarString(mapGet(item, 'type')) === type;
}

/** Index of that component within `components:`, or `-1`. */
function findComponentIndex(entity: YAMLMap, type: string): number {
  const components = mapGet(entity, 'components');
  if (!isSeq(components)) return -1;
  return components.items.findIndex((item) => isComponentOfType(item, type));
}

function findComponent(entity: YAMLMap, type: string): YAMLMap | null {
  const components = mapGet(entity, 'components');
  if (!isSeq(components)) return null;
  const index = findComponentIndex(entity, type);
  return index < 0 ? null : (components.items[index] as YAMLMap);
}

interface Descent {
  readonly container: Node;
  readonly pair: Pair | null;
  readonly missingPath: string[];
}

/**
 * Walk `fieldPath` from `container` through nested maps, stopping at the first
 * key absent from the text (or the first non-map where a map was expected) —
 * mirrors `findField` in `prototype/prototype-surgical-edits/lib/model.mjs`.
 * `missingPath` is the whole untraversed tail; see {@link MissingField}.
 */
function findField(container: Node, fieldPath: readonly string[]): Descent {
  let node: Node = container;
  for (let i = 0; i < fieldPath.length - 1; i++) {
    if (!isMap(node)) {
      return { container: node, pair: null, missingPath: fieldPath.slice(i) };
    }
    const pair = findPair(node, fieldPath[i]);
    if (!pair || pair.value == null) {
      return { container: node, pair: null, missingPath: fieldPath.slice(i) };
    }
    node = pair.value as Node;
  }

  if (fieldPath.length === 0) {
    return { container: node, pair: null, missingPath: [] };
  }

  const last = fieldPath[fieldPath.length - 1];
  if (!isMap(node)) {
    return { container: node, pair: null, missingPath: [last] };
  }
  const pair = findPair(node, last);
  return { container: node, pair, missingPath: pair ? [] : [last] };
}

/** The `&anchor` / `*alias` marks a value node may carry — both optional, usually absent. */
function refMarkers(node: Node | null): { anchor?: string; alias?: string } {
  if (!node) return {};
  if (isAlias(node)) return { alias: node.source };
  const anchor = (node as { anchor?: unknown }).anchor;
  return typeof anchor === 'string' ? { anchor } : {};
}

/** A verbatim `!type:` tag when present, else nothing; the tag is outside the value range. */
function tagMarker(node: Node): { tag?: string } {
  const tag = (node as { tag?: unknown }).tag;
  return typeof tag === 'string' && tag.startsWith('!') ? { tag } : {};
}

function describeValue(pair: Pair | null, container: Node): ResolvedField {
  const value = pair ? ((pair.value as Node | undefined) ?? null) : container;

  // A key that is present in the text but has no value (`event:` with nothing
  // after it): the field exists, so it resolves — as a zero-width range just
  // past the key, never `[0, 0, 0]`.
  if (value == null) {
    const keyEnd = pair ? rangeOf(pair.key as Node)[2] : 0;
    return { range: [keyEnd, keyEnd, keyEnd], valueRange: [keyEnd, keyEnd], kind: 'null' };
  }

  const range = rangeOf(value);
  const common = {
    range,
    valueRange: [range[0], range[1]] as [number, number],
    ...refMarkers(value),
    ...tagMarker(value),
  };

  if (isAlias(value)) return { ...common, kind: 'alias' };
  if (isMap(value)) return { ...common, kind: 'map' };
  if (isSeq(value)) return { ...common, kind: 'seq' };
  if (isScalar(value)) {
    const block = value.type === Scalar.BLOCK_LITERAL || value.type === Scalar.BLOCK_FOLDED;
    return { ...common, kind: block ? 'block-scalar' : value.value === null ? 'null' : 'scalar' };
  }
  return { ...common, kind: 'null' };
}

// ---------------------------------------------------------------------------
// path -> range
// ---------------------------------------------------------------------------

/**
 * Locate the field addressed by `{ entityIndex, component, fieldPath }`.
 *   - `entity-not-found` / `component-not-found` — the container is not in the file.
 *   - `resolved` — the field is in the text; `field` carries its value range
 *     (no trailing whitespace, comment or `!type:` tag) plus alias/anchor/tag marks.
 *   - `missing` — the container exists but the field does not; `missingPath` is
 *     the whole absent key tail, so its length tells apart "missing leaf key"
 *     (1) from "missing container chain" (> 1).
 */
export function resolveField(file: PrototypeFile, address: FieldAddress): FieldResolution {
  const { root } = must(file);
  if (!isSeq(root)) return { outcome: 'entity-not-found' };

  const entity = root.items[address.entityIndex];
  if (!isMap(entity)) return { outcome: 'entity-not-found' };

  let container: YAMLMap = entity;
  if (address.component !== undefined) {
    const component = findComponent(entity, address.component);
    if (!component) return { outcome: 'component-not-found' };
    container = component;
  }

  const descent = findField(container, address.fieldPath);
  if (descent.missingPath.length > 0) {
    return {
      outcome: 'missing',
      missing: {
        missingPath: descent.missingPath,
        containerRange: rangeOf(descent.container),
      },
    };
  }

  return { outcome: 'resolved', field: describeValue(descent.pair, descent.container) };
}

// ---------------------------------------------------------------------------
// offset -> context
// ---------------------------------------------------------------------------

const NOWHERE: CursorContext = {
  entityIndex: null,
  prototypeType: null,
  component: null,
  fieldPath: [],
  fieldTags: [],
  containerKeys: [],
  token: { kind: 'none' },
};

/** True when `offset` falls within `node`'s full range `[start, nodeEnd)`. */
function spans(node: unknown, offset: number): node is Node {
  const range = (node as Node | null | undefined)?.range;
  return !!range && offset >= range[0] && offset < range[2];
}

/**
 * True only when `offset` is on the *value* slot of `type:` — strictly past the
 * `type` key, up to the value's text end (or the rest of the line when nothing
 * is typed yet). On the key itself, or on the next line, this is false so the
 * caller falls through to {@link descend}.
 */
function onComponentTypeSlot(typePair: Pair, offset: number, text: string): boolean {
  const keyRange = (typePair.key as Node | null)?.range;
  if (!keyRange || offset <= keyRange[1]) return false;
  const valueRange = (typePair.value as Node | null)?.range;
  if (valueRange) return offset <= valueRange[1];
  const newline = text.indexOf('\n', keyRange[1]);
  return offset <= (newline === -1 ? text.length : newline);
}

/**
 * One sequence-valued field met on the way down to the caret, put to
 * {@link CursorContextOptions.isComponentRegistry}. Its shape is a plain field
 * reference, so a caller can answer with the same chain walk it uses for
 * everything else.
 */
export interface RegistrySite {
  readonly prototypeType: string | null;
  /** Innermost component the field sits in, or `null` when it is on the prototype map. */
  readonly component: string | null;
  /** Key chain from that root down to the field, the field's own key last. */
  readonly fieldPath: readonly string[];
  /** `!type:` tag descended through at each step, aligned with {@link fieldPath}. */
  readonly fieldTags: readonly (string | null)[];
}

export interface CursorContextOptions {
  /**
   * Whether the sequence-valued field at `site` is a `ComponentRegistry` — a list
   * of `- type: X` component blocks whose contents are addressed from the
   * component, not from the prototype.
   *
   * `ComponentRegistry` is an ordinary field type, not a structural feature of
   * the document, so only a caller holding the schema can tell one apart. The
   * engine has ~70 of them and they sit at every depth: on prototypes
   * (`entity.components`, `borgType.addComponents`), on components themselves
   * (`ComponentToggler.removeComponents`) and inside nested `[DataDefinition]`s
   * (`SlotDefinition.dependsOnComponents`). Defaults to the prototype's own
   * `components:`, the one case a schema-free caller can name.
   */
  readonly isComponentRegistry?: (site: RegistrySite) => boolean;
}

/** The only registry a schema-free caller gets: `components:` on the prototype map. */
function isDefaultRegistry(site: RegistrySite): boolean {
  return site.component === null && site.fieldPath.length === 1 && site.fieldPath[0] === 'components';
}

/** Everything the walk needs that does not change as it descends. */
interface Walk {
  readonly offset: number;
  readonly text: string;
  readonly prototypeType: string | null;
  readonly isRegistry: (site: RegistrySite) => boolean;
}

/**
 * Where the walk stands: the component root it is under (`null` on the prototype
 * map) and the key chain plus tags collected since that root. Crossing into a
 * component registry starts a fresh frame.
 */
interface Frame {
  readonly component: string | null;
  readonly chain: readonly string[];
  readonly tags: readonly (string | null)[];
}

const ROOT_FRAME: Frame = { component: null, chain: [], tags: [] };

/** What the walk landed on. `null` from any step means "the offset is not on anything here". */
interface Landing {
  readonly component: string | null;
  readonly fieldPath: readonly string[];
  readonly fieldTags: readonly (string | null)[];
  readonly containerKeys: readonly string[];
  readonly token: CursorToken;
  readonly node: Node | null;
}

/** A verbatim `!type:` tag carried by a node, or `null`. */
function tagOf(node: Node | null | undefined): string | null {
  const tag = (node as { tag?: unknown } | null | undefined)?.tag;
  return typeof tag === 'string' && tag.startsWith('!') ? tag : null;
}

/**
 * Find the pair in `map` whose line/block `offset` sits on, then keep walking
 * into its value. Each pair owns the text from its key start up to the next key
 * (or the map's end), so an offset in the `key: ` gap or past a `key:` with no
 * value still lands on that field as a `value` token — the point completion
 * fires. A value the walk cannot enter (a scalar, or a container the offset is
 * not actually inside) falls back to that same `value` token.
 */
function walkMap(map: YAMLMap, frame: Frame, walk: Walk): Landing | null {
  const items = map.items;
  const mapEnd = map.range?.[2] ?? Number.MAX_SAFE_INTEGER;
  const containerKeys = keysOf(map);

  for (let i = 0; i < items.length; i++) {
    const pair = items[i];
    const keyName = scalarString(pair.key);
    const keyRange = (pair.key as Node | null)?.range;
    if (keyName === undefined || !keyRange) continue;

    const nextKeyStart =
      i + 1 < items.length ? (items[i + 1].key as Node | null)?.range?.[0] ?? mapEnd : mapEnd;
    if (walk.offset < keyRange[0] || walk.offset >= nextKeyStart) continue;

    const value = (pair.value as Node | undefined) ?? null;
    const here: Frame = {
      component: frame.component,
      chain: [...frame.chain, keyName],
      tags: [...frame.tags, tagOf(value)],
    };
    const landed = (token: CursorToken): Landing => ({
      component: frame.component,
      fieldPath: here.chain,
      fieldTags: here.tags,
      containerKeys,
      token,
      node: value,
    });

    if (walk.offset <= keyRange[1]) return landed({ kind: 'key', name: keyName });
    return walkValue(value, here, walk) ?? landed({ kind: 'value' });
  }
  return null;
}

/** Walk into a pair's value: a nested map, a component registry, or a plain sequence. */
function walkValue(value: Node | null, frame: Frame, walk: Walk): Landing | null {
  if (!value || !spans(value, walk.offset)) return null;
  if (isMap(value)) return walkMap(value, frame, walk);
  if (!isSeq(value)) return null;

  const site: RegistrySite = {
    prototypeType: walk.prototypeType,
    component: frame.component,
    fieldPath: frame.chain,
    fieldTags: frame.tags,
  };
  return walk.isRegistry(site) ? walkRegistry(value, walk) : walkSeq(value, frame, walk);
}

/**
 * A plain sequence. Its items all share the field's declared element type, so an
 * index carries nothing a schema lookup could use and never enters the key
 * chain. A `!type:` tag on the item does carry something — it names the concrete
 * member of a union — so it replaces the (untagged) sequence's own entry in the
 * tag chain.
 */
function walkSeq(seq: YAMLSeq, frame: Frame, walk: Walk): Landing | null {
  const item = seq.items.find((candidate) => spans(candidate, walk.offset)) as Node | undefined;
  if (!item) return null;

  const framed: Frame = { ...frame, tags: [...frame.tags.slice(0, -1), tagOf(item)] };
  if (isMap(item)) return walkMap(item, framed, walk);
  if (isSeq(item)) return walkSeq(item, framed, walk);
  return null;
}

/**
 * A `ComponentRegistry` sequence: every item is a `- type: X` block whose fields
 * belong to that component, so the caret inside one is addressed from the
 * component and the frame starts over.
 */
function walkRegistry(seq: YAMLSeq, walk: Walk): Landing | null {
  const item = seq.items.find((candidate) => spans(candidate, walk.offset));
  if (!isMap(item)) return null;

  const typePair = findPair(item, 'type');
  const component = typePair ? scalarString(typePair.value) ?? null : null;

  if (typePair && onComponentTypeSlot(typePair, walk.offset, walk.text)) {
    return {
      component,
      fieldPath: [],
      fieldTags: [],
      containerKeys: [],
      token: { kind: 'component-type', text: component },
      node: null,
    };
  }
  return walkMap(item, { component, chain: [], tags: [] }, walk);
}

/**
 * Describe where `offset` sits: which prototype and (inside a component
 * registry, at any depth) which component, the key chain to the field with the
 * `!type:` tags it descended through, and whether the caret is on a key, a
 * value, or the `type:` slot of a component entry — plus alias/anchor marks on
 * the value under it. Returns {@link NOWHERE} for an offset outside every
 * prototype.
 */
export function cursorContextAt(
  file: PrototypeFile,
  offset: number,
  options?: CursorContextOptions,
): CursorContext {
  const { root, text } = must(file);
  if (!isSeq(root)) return NOWHERE;

  const entityIndex = root.items.findIndex((item) => spans(item, offset));
  if (entityIndex < 0) return NOWHERE;

  const entity = root.items[entityIndex];
  const prototypeType = isMap(entity) ? scalarString(mapGet(entity, 'type')) ?? null : null;
  const shell = { entityIndex, prototypeType };
  const nothingHere: CursorContext = {
    ...shell,
    component: null,
    fieldPath: [],
    fieldTags: [],
    containerKeys: [],
    token: { kind: 'none' },
  };

  if (!isMap(entity)) return nothingHere;

  const landing = walkMap(entity, ROOT_FRAME, {
    offset,
    text,
    prototypeType,
    isRegistry: options?.isComponentRegistry ?? isDefaultRegistry,
  });
  if (!landing) return nothingHere;

  return {
    ...shell,
    component: landing.component,
    fieldPath: landing.fieldPath,
    fieldTags: landing.fieldTags,
    containerKeys: landing.containerKeys,
    token: landing.token,
    ...refMarkers(landing.node),
  };
}

// ---------------------------------------------------------------------------
// path -> surgical edit  (spec #20 "Хирургические правки"; issue #26)
//
// A straight port of `prototype/prototype-surgical-edits/lib/edits.mjs`. Every
// function returns exactly one splice against `file.text`; nothing here builds
// or re-serialises a YAML string. The raw new text is inserted verbatim — quote
// style is never recomputed, so a value that needs quoting after the change is
// the caller's problem, not this module's.
// ---------------------------------------------------------------------------

/**
 * A single splice against {@link PrototypeFile.text}: replace the half-open
 * offset span `range` with `newText`. Because it is the only shape this module
 * emits, comments, key order, anchors and `!type:` tags outside `range` stay
 * byte-for-byte intact — nobody touched them.
 */
export interface SurgicalEdit {
  readonly range: readonly [start: number, end: number];
  readonly newText: string;
}

/**
 * Result of asking for an edit.
 *   - `edit` — a splice to apply.
 *   - `entity-not-found` / `component-not-found` / `field-not-found` — the target
 *     the address names is not in the text.
 *   - `rejected` — the target exists but the edit is refused on purpose (an
 *     alias-valued field, a block scalar handed to the plain-scalar path, a
 *     container with no sibling key to align an inserted key to). `reason` is a
 *     developer-facing sentence, never surfaced raw to the end user.
 */
export type EditOutcome =
  | { readonly outcome: 'edit'; readonly edit: SurgicalEdit }
  | { readonly outcome: 'entity-not-found' }
  | { readonly outcome: 'component-not-found' }
  | { readonly outcome: 'field-not-found' }
  | { readonly outcome: 'rejected'; readonly reason: string };

/**
 * Block indent step. Two, measured in `prototype/prototype-surgical-edits` on
 * `FireAxe.MeleeWeapon.damage -> types -> Blunt` (step of exactly 2 between every
 * level) and reused there for the `insertComponentBlock` dash — not a guess.
 */
const INDENT_STEP = 2;

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Human-readable node kind for a `rejected` reason — no runtime class name. */
function nodeKind(node: Node): string {
  if (isAlias(node)) return 'an alias';
  if (isMap(node)) return 'a map';
  if (isSeq(node)) return 'a sequence';
  if (isScalar(node)) {
    return node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED
      ? 'a block scalar'
      : 'a scalar';
  }
  return 'not a scalar';
}

/** Column (0-based) at `offset` — i.e. the indent width when `offset` is a key start. */
function columnAt(file: PrototypeFile, offset: number): number {
  return positionAt(file, offset).character;
}

/** Offset of the start of the line `offset` sits on. */
function lineStartAt(text: string, offset: number): number {
  const nl = text.lastIndexOf('\n', offset - 1);
  return nl === -1 ? 0 : nl + 1;
}

/**
 * Start offset for deleting the FIRST item of a sequence. `lineStartAt` alone
 * covers the "orphan indent" hazard (the CST marker offset of item 0 skips its
 * own line indent). When the item also owns a leading comment — only the
 * top-level prototype sequence, where the container node does not exist yet when
 * the composer meets the comment — walk further back over the contiguous
 * comment / blank-line block so the comment leaves with the item.
 */
function firstItemStart(text: string, anchor: number, ownsCommentBefore: boolean): number {
  let ls = lineStartAt(text, anchor);
  if (!ownsCommentBefore) return ls;
  while (ls > 0) {
    const prevLs = lineStartAt(text, ls - 1);
    const prevLine = text.slice(prevLs, ls).replace(/\r?\n$/, '');
    if (prevLine !== '' && !/^\s*#/.test(prevLine)) break;
    ls = prevLs;
  }
  return ls;
}

/** `node.srcToken.items[index].start[0].offset` when `keepSourceTokens` populated it. */
function cstItemStartOffset(node: Node, index: number): number | undefined {
  const srcToken = (node as { srcToken?: unknown }).srcToken as
    | { items?: ReadonlyArray<{ start?: ReadonlyArray<{ offset?: number }> }> }
    | undefined;
  return srcToken?.items?.[index]?.start?.[0]?.offset;
}

/**
 * `{ ok: true, ... }` / `{ ok: false, result }` — the tagged-discriminant idiom
 * this module and its siblings use for "a value, or the outcome to return".
 */
type Lookup<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: EditOutcome };

/** The prototype map at `entityIndex`, or the outcome to return when it is not there. */
function lookupEntity(file: PrototypeFile, entityIndex: number): Lookup<YAMLMap> {
  const { root } = must(file);
  const entity = isSeq(root) ? root.items[entityIndex] : undefined;
  if (!isMap(entity)) return { ok: false, result: { outcome: 'entity-not-found' } };
  return { ok: true, value: entity };
}

/** Resolve `address` to its container map (the component map, or the entity map itself). */
function lookupContainer(file: PrototypeFile, address: FieldAddress): Lookup<YAMLMap> {
  const entity = lookupEntity(file, address.entityIndex);
  if (!entity.ok) return entity;
  if (address.component === undefined) return entity;

  const component = findComponent(entity.value, address.component);
  if (!component) return { ok: false, result: { outcome: 'component-not-found' } };
  return { ok: true, value: component };
}

/** The value node the address points at, or `null` for a key with nothing after it. */
function valueOf(descent: Descent, container: Node): Node | null {
  if (descent.pair) return (descent.pair.value as Node | undefined) ?? null;
  return container; // fieldPath was empty — the container is the "value"
}

/** Shared prelude for the two value-replacing edits: resolve the address to a value node. */
function lookupValue(file: PrototypeFile, address: FieldAddress): Lookup<Node> {
  const container = lookupContainer(file, address);
  if (!container.ok) return container;

  const descent = findField(container.value, address.fieldPath);
  if (descent.missingPath.length > 0) return { ok: false, result: { outcome: 'field-not-found' } };

  const value = valueOf(descent, descent.container);
  if (value == null) {
    return { ok: false, result: { outcome: 'rejected', reason: 'the key has no value to replace' } };
  }
  return { ok: true, value };
}

function aliasReason(value: Alias): string {
  return (
    `field resolves to the alias *${value.source}; editing it in place would rewrite only this ` +
    `reference and break the tie to its anchor. Detach it from the anchor first.`
  );
}

/**
 * Class 1 — replace a scalar value in place. `range` is the value text only: no
 * trailing whitespace, comment, `&anchor` marker or `!type:` tag. An anchored
 * scalar edits fine (aliases pick the new text up on re-parse); an alias-valued
 * field is `rejected`; a block scalar is `rejected` towards {@link replaceBlockScalarValue}.
 */
export function replaceScalarValue(
  file: PrototypeFile,
  address: FieldAddress,
  newRaw: string,
): EditOutcome {
  const found = lookupValue(file, address);
  if (!found.ok) return found.result;
  const { value } = found;

  if (isAlias(value)) return { outcome: 'rejected', reason: aliasReason(value) };
  if (isScalar(value) && (value.type === Scalar.BLOCK_LITERAL || value.type === Scalar.BLOCK_FOLDED)) {
    return { outcome: 'rejected', reason: 'value is a block scalar; use replaceBlockScalarValue' };
  }
  if (!isScalar(value)) {
    return { outcome: 'rejected', reason: `value is ${nodeKind(value)}, not a scalar` };
  }

  const range = rangeOf(value);
  return { outcome: 'edit', edit: { range: [range[0], range[1]], newText: newRaw } };
}

/**
 * Block scalar (`|`, `>`, `|-`, …) — the node range covers the indicator line and
 * every content line as one raw span, so a plain splice would flatten it.
 * Rebuild instead: keep the exact header line (any same-line comment with it),
 * reuse the real content indent read from the first non-blank content line
 * (never assume 2/4), re-indent each new line onto it. The splice runs to the
 * node's `range[2]`, so trailing blank lines inside that range are dropped —
 * faithful to the donor prototype.
 */
export function replaceBlockScalarValue(
  file: PrototypeFile,
  address: FieldAddress,
  newLines: readonly string[],
): EditOutcome {
  const found = lookupValue(file, address);
  if (!found.ok) return found.result;
  const { value } = found;

  if (isAlias(value)) return { outcome: 'rejected', reason: aliasReason(value) };
  if (
    !isScalar(value) ||
    (value.type !== Scalar.BLOCK_LITERAL && value.type !== Scalar.BLOCK_FOLDED)
  ) {
    return { outcome: 'rejected', reason: `value is ${nodeKind(value)}, not a block scalar` };
  }

  const { text } = must(file);
  const eol = eolOf(text);
  const range = rangeOf(value);
  const raw = text.slice(range[0], range[1]);
  const nl = raw.indexOf('\n');
  const header = (nl === -1 ? raw : raw.slice(0, nl)).replace(/\r$/, '');
  const firstContentLine = (nl === -1 ? '' : raw.slice(nl + 1))
    .split('\n')
    .find((line) => line.trim() !== '');
  const indent = firstContentLine?.match(/^( +)/)?.[1] ?? ' '.repeat(columnAt(file, range[0]) + INDENT_STEP);
  const body = newLines.map((line) => `${indent}${line}${eol}`).join('');

  return { outcome: 'edit', edit: { range: [range[0], range[2]], newText: `${header}${eol}${body}` } };
}

/**
 * Classes 2 & 4 — materialise a field that is only inherited: a single missing
 * leaf key, or a whole missing container chain. At depth 1 this emits byte-for-
 * byte what a dedicated "insert one key" would. Insertion point is the end of
 * the deepest container that DOES exist (`range[2]`), which sits after any
 * standalone trailing comment that the CST hangs on the container — so the
 * comment stays put. New keys align to the first sibling key's column, each
 * deeper level indented one more {@link INDENT_STEP}.
 */
export function insertField(
  file: PrototypeFile,
  address: FieldAddress,
  newRaw: string,
): EditOutcome {
  const outer = lookupContainer(file, address);
  if (!outer.ok) return outer.result;

  const descent = findField(outer.value, address.fieldPath);
  if (descent.missingPath.length === 0) {
    return { outcome: 'rejected', reason: 'field is already in the text; use replaceScalarValue' };
  }
  const container = descent.container;
  if (!isMap(container) || container.items.length === 0) {
    return {
      outcome: 'rejected',
      reason: 'target container is not a non-empty block map — no sibling key to align to',
    };
  }

  const { text } = must(file);
  const eol = eolOf(text);
  const baseCol = columnAt(file, rangeOf(container.items[0].key as Node)[0]);
  const at = rangeOf(container)[2];
  const block = descent.missingPath
    .map((key, i) => {
      const pad = ' '.repeat(baseCol + i * INDENT_STEP);
      const isLeaf = i === descent.missingPath.length - 1;
      return `${pad}${key}:${isLeaf ? ` ${newRaw}` : ''}${eol}`;
    })
    .join('');

  return { outcome: 'edit', edit: { range: [at, at], newText: block } };
}

/**
 * Class 3 — append a whole `- type: X` block to an entity's `components:`.
 * `lines` is the block body already split into lines, `type: X` first. Insertion
 * point is the end of the sequence itself (`range[2]`), past any standalone
 * comment the CST hangs on it. The dash sits {@link INDENT_STEP} columns left of
 * the field column, taken from the first existing component's first field.
 */
export function insertComponent(
  file: PrototypeFile,
  entityIndex: number,
  lines: readonly string[],
): EditOutcome {
  const entity = lookupEntity(file, entityIndex);
  if (!entity.ok) return entity.result;

  if (lines.length === 0) return { outcome: 'rejected', reason: 'no lines to insert' };

  const { text } = must(file);
  const seq = findPair(entity.value, 'components')?.value ?? null;
  const first = isSeq(seq) ? seq.items[0] : null;
  if (!isSeq(seq) || !isMap(first) || first.items.length === 0) {
    return {
      outcome: 'rejected',
      reason: 'entity has no non-empty components: sequence to append to',
    };
  }

  const fieldCol = columnAt(file, rangeOf(first.items[0].key as Node)[0]);
  if (fieldCol < INDENT_STEP) {
    return { outcome: 'rejected', reason: 'component fields sit too far left for a dash two columns in' };
  }

  const eol = eolOf(text);
  const at = rangeOf(seq)[2];
  const [head, ...rest] = lines;
  const newText =
    `${' '.repeat(fieldCol - INDENT_STEP)}- ${head}${eol}` +
    rest.map((line) => `${' '.repeat(fieldCol)}${line}${eol}`).join('');

  return { outcome: 'edit', edit: { range: [at, at], newText } };
}

function deleteSeqItemEdit(
  text: string,
  seq: YAMLSeq,
  index: number,
  notFound: EditOutcome,
): EditOutcome {
  const item = seq.items[index] as Node | undefined;
  if (!item) return notFound;
  const anchor = cstItemStartOffset(seq, index) ?? rangeOf(item)[0];
  const start =
    index === 0 ? firstItemStart(text, anchor, Boolean(item.commentBefore)) : anchor;
  return { outcome: 'edit', edit: { range: [start, rangeOf(item)[2]], newText: '' } };
}

function deleteMapKeyEdit(text: string, map: YAMLMap, key: string): EditOutcome {
  const index = map.items.findIndex((pair) => scalarString(pair.key) === key);
  if (index < 0) return { outcome: 'field-not-found' };
  const pair = map.items[index];
  const keyStart = rangeOf(pair.key as Node)[0];
  const start = index === 0 ? lineStartAt(text, keyStart) : cstItemStartOffset(map, index) ?? keyStart;
  const endNode = (pair.value as Node | null) ?? (pair.key as Node);
  return { outcome: 'edit', edit: { range: [start, rangeOf(endNode)[2]], newText: '' } };
}

/**
 * Delete what `address` names and the comment the CST physically ties to it:
 *   - `fieldPath` empty, no `component` — a whole prototype from the top-level
 *     sequence (special-cased for `index === 0`: leading comment leaves with it,
 *     start snaps to the marker's line so a nested list below is not orphaned).
 *   - `fieldPath` empty, `component` set — that component from `components:`.
 *   - `fieldPath` non-empty — that key from its map (entity or component).
 *
 * No comment-retention policy: a container comment survives deletion of the
 * first item because the CST puts it on the container; an item's own leading
 * comment goes with the item. That asymmetry is the intended final behaviour.
 */
export function deleteAt(file: PrototypeFile, address: FieldAddress): EditOutcome {
  const { text, root } = must(file);
  const entity = lookupEntity(file, address.entityIndex);
  if (!entity.ok) return entity.result;

  if (address.component === undefined && address.fieldPath.length === 0) {
    // isSeq(root) is implied — lookupEntity found a map inside it.
    return deleteSeqItemEdit(text, root as YAMLSeq, address.entityIndex, { outcome: 'entity-not-found' });
  }

  if (address.component !== undefined && address.fieldPath.length === 0) {
    const seq = findPair(entity.value, 'components')?.value ?? null;
    const index = findComponentIndex(entity.value, address.component);
    if (!isSeq(seq) || index < 0) return { outcome: 'component-not-found' };
    return deleteSeqItemEdit(text, seq, index, { outcome: 'component-not-found' });
  }

  const container = lookupContainer(file, address);
  if (!container.ok) return container.result;
  const descent = findField(container.value, address.fieldPath);
  if (descent.missingPath.length > 0 || !descent.pair || !isMap(descent.container)) {
    return { outcome: 'field-not-found' };
  }
  return deleteMapKeyEdit(text, descent.container, address.fieldPath[address.fieldPath.length - 1]);
}
