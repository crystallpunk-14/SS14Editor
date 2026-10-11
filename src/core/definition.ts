/**
 * Go-to-definition for prototype ids (spec #20, "Текстовые провайдеры";
 * issue #33). Pure core: text + offset + schema snapshot + prototype index in,
 * the declaration to jump to as data out. The host adapter
 * ({@link file://../host/text-providers.ts}) turns it into a `LocationLink`;
 * VS Code then serves it on both Ctrl+Click and F12.
 *
 * The caret must sit on the value of a field that names a prototype — the same
 * question autocomplete asks ({@link protoRefKindAt}): `parent:` (scalar, block
 * list or flow list), `ProtoId<T>`, `EntProtoId`, and lists of them. The id is
 * looked up under that field's kind only, so an entity id written in a reagent
 * field has no target.
 */

import { contextAt, protoRefKindAt } from './completion';
import type { PrototypeIndexView, PrototypeRecord } from './prototype-index';
import { parsePrototypeFile } from './prototype-yaml';
import type { SchemaRoot } from './schema-contract';

/** Where to jump, and which text it was asked from. */
export interface DefinitionTarget {
  /** `[start, end)` of the id under the caret — the link the editor underlines. */
  readonly origin: readonly [number, number];
  /** The index record of the declaration: fork-relative `filePath` plus its `range`. */
  readonly target: PrototypeRecord;
}

/**
 * The declaration of the prototype id at `offset` in `text`. `null` when the
 * index is not ready, the caret is not on a prototype-id value, or the index
 * holds no prototype of that kind and id.
 */
export function definitionAt(
  text: string,
  offset: number,
  schema: SchemaRoot,
  index: PrototypeIndexView,
): DefinitionTarget | null {
  if (!index.ready) return null;

  const file = parsePrototypeFile(text);
  if (!file.ok) return null;

  const ctx = contextAt(file, offset, schema);
  if (ctx.token.kind !== 'value') return null;
  const kind = protoRefKindAt(ctx, schema);
  if (kind === null) return null;

  const origin = idSpanAt(file.text, offset);
  if (!origin) return null;

  const lookup = index.get(kind, file.text.slice(origin[0], origin[1]));
  return lookup.ready && lookup.record ? { origin, target: lookup.record } : null;
}

/**
 * A character that can be part of an id as written in YAML: anything but
 * whitespace, the flow-collection punctuation, quotes, `:` and `#`. That spans
 * one plain or quoted id, and one item of `[A, B]`.
 */
const ID_CHAR = /[^\s,[\]{}:#'"]/;

/** The run of {@link ID_CHAR}s the caret touches, or `null` when it touches none. */
function idSpanAt(text: string, offset: number): [number, number] | null {
  let start = offset;
  while (start > 0 && ID_CHAR.test(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && ID_CHAR.test(text[end])) end++;
  return start === end ? null : [start, end];
}
