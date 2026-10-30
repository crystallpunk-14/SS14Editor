/**
 * Whole-file checks of a prototype file (Rider plan, stage 4). Pure core: text,
 * schema snapshot and prototype index in, problems as offsets out. A host maps
 * them to its own diagnostics (`textDocument/publishDiagnostics` in the server).
 *
 * Each rule asks exactly the question the matching completion asks, through the
 * same cursor context, so a value the list would offer is never flagged:
 *
 *   - `unknown-component`: a component registry's `type:` names no component of
 *     the schema;
 *   - `unknown-prototype`: a prototype reference (`parent:`, `ProtoId<T>`,
 *     `EntProtoId`, lists and dictionary keys of them) names no prototype of
 *     that kind in the index;
 *   - `invalid-enum-value`: an enum or flags value is none of the type's names,
 *     read the way the engine reads it (`Enum.TryParse(..., ignoreCase: true)`:
 *     any case, a number, or `A, B` / a list of names).
 *
 * Anything the schema or the index cannot answer is left alone: an unparseable
 * file, an index that is not ready, a prototype kind the index has no record of
 * at all (a kind-name mismatch rather than a typo), an enum with no names.
 */

import { contextAt, enumChoicesAt, protoRefKindAt } from './completion';
import type { PrototypeIndexView } from './prototype-index';
import { parsePrototypeFile, scalarSites } from './prototype-yaml';
import type { SchemaRoot } from './schema-contract';

export type DiagnosticCode = 'unknown-component' | 'unknown-prototype' | 'invalid-enum-value';

export interface PrototypeDiagnostic {
  /** `[start, end)` of the offending scalar in the BOM-stripped text. */
  readonly range: readonly [number, number];
  readonly code: DiagnosticCode;
  /** English text; a host that shows another language builds its own from the fields below. */
  readonly message: string;
  /** The value as written: the component name, the id, the enum value. */
  readonly value: string;
  /** `unknown-prototype`: the prototype kind the id was looked up under. */
  readonly kind?: string;
  /** `invalid-enum-value`: the names the type accepts. */
  readonly choices?: readonly string[];
}

export function diagnosticsFor(
  text: string,
  schema: SchemaRoot,
  index: PrototypeIndexView | undefined,
): PrototypeDiagnostic[] {
  const file = parsePrototypeFile(text);
  if (!file.ok) return [];

  const knownKinds = index?.ready ? kindsIn(index) : null;
  const diagnostics: PrototypeDiagnostic[] = [];

  for (const site of scalarSites(file)) {
    const value = site.value.trim();
    if (value === '') continue;
    const ctx = contextAt(file, site.range[0], schema);
    const range = site.range;

    if (ctx.token.kind === 'component-type') {
      if (!Object.hasOwn(schema.components, value)) {
        diagnostics.push({ range, code: 'unknown-component', value, message: `Unknown component "${value}".` });
      }
      continue;
    }

    const kind = protoRefKindAt(ctx, schema);
    if (kind !== null) {
      if (index && knownKinds?.has(kind)) {
        const lookup = index.get(kind, value);
        if (lookup.ready && !lookup.record) {
          diagnostics.push({
            range,
            code: 'unknown-prototype',
            value,
            kind,
            message: `No ${kind} prototype with id "${value}".`,
          });
        }
      }
      continue;
    }

    const choices = enumChoicesAt(ctx, schema);
    if (choices && !isEnumValue(value, choices)) {
      diagnostics.push({
        range,
        code: 'invalid-enum-value',
        value,
        choices,
        message: `"${value}" is not one of: ${choices.join(', ')}.`,
      });
    }
  }
  return diagnostics;
}

/** Every prototype kind the index holds at least one record of. */
function kindsIn(index: PrototypeIndexView): Set<string> {
  const kinds = new Set<string>();
  for (const record of index.all()) kinds.add(record.kind);
  return kinds;
}

/** A plain integer, which `Enum.TryParse` accepts for any enum. */
const NUMBER = /^[+-]?\d+$/;

/** `Enum.TryParse` with `ignoreCase`: a number, or comma-separated member names in any case. */
function isEnumValue(value: string, choices: readonly string[]): boolean {
  if (NUMBER.test(value)) return true;
  const names = new Set(choices.map((choice) => choice.toLowerCase()));
  return value.split(',').every((part) => names.has(part.trim().toLowerCase()));
}

