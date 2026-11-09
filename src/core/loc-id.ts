/**
 * LocId values in prototype YAML: which value under the caret, or which values
 * across a whole document, are localization keys — a slot the schema declares
 * `LocId` (`LocId?`, a list of them, a dictionary of them). Pure core: text +
 * schema in, spans out. The host folds these spans into their translation,
 * jumps from them to the `.ftl` declarations, and documents them on hover.
 */

import { contextAt, onLocIdSlot } from './completion';
import { declarationSpan, type LocRecord, type LocTranslation } from './localization-index';
import { parsePrototypeFile, valueScalarsOf, type PrototypeFile, type ScalarSpan } from './prototype-yaml';
import type { SchemaRoot } from './schema-contract';

/** A LocId value as written. */
export interface LocIdSpan {
  /** `[start, end)` of the key text, quotes excluded. */
  readonly range: readonly [number, number];
  /** `[start, end)` of the value as written, YAML quotes included — what a fold hides. */
  readonly outer: readonly [number, number];
  readonly key: string;
}

/** The LocId value the caret touches, or `null` off one (or when the file does not parse). */
export function locIdAt(text: string, offset: number, schema: SchemaRoot): LocIdSpan | null {
  const file = parsePrototypeFile(text);
  if (!file.ok) return null;
  const scalar = valueScalarsOf(file).find(({ outer }) => offset >= outer[0] && offset <= outer[1]);
  if (!scalar || !isLocId(file, scalar.range[0], schema)) return null;
  return toSpan(scalar);
}

/**
 * Every LocId value in `text` whose key `isDeclared` accepts, in source order.
 * `isDeclared` is checked first — it is a map lookup, while telling a slot's type walks the
 * document — so values that are not keys at all cost almost nothing.
 */
export function locIdSpansIn(
  text: string,
  schema: SchemaRoot,
  isDeclared: (key: string) => boolean,
): LocIdSpan[] {
  const file = parsePrototypeFile(text);
  if (!file.ok) return [];
  return valueScalarsOf(file)
    .filter((scalar) => isDeclared(scalar.value) && isLocId(file, scalar.range[0], schema))
    .map(toSpan);
}

function toSpan(scalar: ScalarSpan): LocIdSpan {
  return { range: scalar.range, outer: scalar.outer, key: scalar.value };
}

function isLocId(file: PrototypeFile, offset: number, schema: SchemaRoot): boolean {
  return onLocIdSlot(contextAt(file, offset, schema), schema);
}

/** Longest translation a hover shows in full. */
const MAX_HOVER_TEXT = 300;

/**
 * The hover for a LocId: the key, then each locale's text with where it is
 * declared. `linkOf` turns a record and the 0-based line `key` is declared on
 * into a link target (the host knows the fork root); without it the place is
 * plain text. No translations at all reads as "not found".
 */
export function locHoverMarkdown(
  key: string,
  translations: readonly LocTranslation[],
  linkOf?: (record: LocRecord, line: number) => string,
): string {
  const head = ['```fluent', key, '```'].join('\n');
  if (translations.length === 0) return `${head}\n\n*No translation found.*`;
  const lines = translations.map(({ locale, record, text }) => {
    const shown = text.length > MAX_HOVER_TEXT ? `${text.slice(0, MAX_HOVER_TEXT)}…` : text;
    const file = record.filePath.slice(record.filePath.lastIndexOf('/') + 1);
    const { line } = declarationSpan(record, key);
    const place = `${escapeMarkdown(file)}:${line + 1}`;
    const where = linkOf ? `[${place}](${linkOf(record, line)})` : place;
    return `- **${locale}**: ${escapeMarkdown(shown) || '*(empty)*'} — ${where}`;
  });
  return `${head}\n\n${lines.join('\n')}`;
}

/** Longest folded preview; the rest is cut with `…`. */
const MAX_PREVIEW_LENGTH = 60;

/** The text a LocId key folds into: quoted, cut to {@link MAX_PREVIEW_LENGTH}. */
export function foldedText(preview: string): string {
  const cut = preview.length > MAX_PREVIEW_LENGTH ? `${preview.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : preview;
  return `"${cut}"`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}
