/**
 * Hover documentation for prototype YAML (spec #20, "Текстовые провайдеры";
 * issue #30). Pure core: text + offset + schema snapshot in, what the caret
 * names — its C# type, XML-doc summary and default — as data out, plus the
 * markdown the host shows for it. The host adapter
 * ({@link file://../host/text-providers.ts}) only wraps that in a `Hover`.
 *
 * Three things answer a hover, all read through the cursor context (issue #24)
 * the way autocomplete reads it:
 *
 *   - a component name after `- type:` — its class and summary;
 *   - a `!type:` tag — the union member it picks, and that class's summary;
 *   - a field key — of a component, a `[DataDefinition]` (through any `!type:`
 *     on the way) or the prototype itself: its summary, type and default.
 *
 * Anything else — a value, a dictionary entry's key, a name the schema does not
 * know — has no hover.
 */

import type { ClassLocator } from './class-location';
import { contextAt, fieldOwnerAt } from './completion';
import { classAt, idSpanAt } from './definition';
import { parsePrototypeFile } from './prototype-yaml';
import type { FieldMetadata, SchemaRoot } from './schema-contract';

/** What the caret names, as the hover shows it. */
export type HoverContent = ClassHover | FieldHover;

/** A component name or a `!type:` tag — the C# class it names. */
export interface ClassHover {
  /** `[start, end)` of the name under the caret — the span the hover belongs to. */
  readonly origin: readonly [number, number];
  readonly kind: 'component' | 'type';
  /** As written: a component's registration name, a tag's member name. */
  readonly name: string;
  /** The class's full C# name. */
  readonly type: string;
  /** The XML-doc summary, or `null` when the schema carries none. */
  readonly summary: string | null;
}

/** A field key — of a component, a `[DataDefinition]` or the prototype itself. */
export interface FieldHover {
  readonly origin: readonly [number, number];
  readonly kind: 'field';
  /** The field's YAML tag. */
  readonly name: string;
  /** The field's C# type, as C# writes it. */
  readonly type: string;
  readonly summary: string | null;
  /** The default as the schema knows it, or `null` when it knows none. */
  readonly default: string | null;
  /** A `[DataField(required: true)]` field. */
  readonly required: boolean;
  /** The C# member behind the tag — what its declaration is looked up by. */
  readonly member: string;
  /** Full C# name of the class the field was found on (it may be declared on a base); `null` when unknown. */
  readonly owner: string | null;
}

/** The hover for `offset` in `text`, or `null` when the caret names nothing the schema documents. */
export function hoverAt(text: string, offset: number, schema: SchemaRoot): HoverContent | null {
  const file = parsePrototypeFile(text);
  if (!file.ok) return null;

  const ctx = contextAt(file, offset, schema);
  const named = classAt(file, ctx, offset, schema);
  if (named) {
    const documented =
      named.kind === 'component' ? schema.components[named.name] : schema.dataDefinitions[named.className];
    return {
      origin: named.origin,
      kind: named.kind,
      name: named.name,
      type: named.className,
      summary: summaryOf(documented),
    };
  }

  const owned = fieldOwnerAt(ctx, schema);
  const origin = owned && idSpanAt(file.text, offset);
  if (!owned || !origin) return null;
  const { field, owner } = owned;
  return {
    origin,
    kind: 'field',
    name: field.tag,
    type: field.fullType ? readableTypeName(field.fullType) : field.type,
    summary: summaryOf(field),
    default: defaultOf(field),
    required: field.required,
    member: field.name,
    owner,
  };
}

/**
 * `hover` with its summary read from the `///` comment in source when the
 * schema has none — forks rarely build XML docs, so it seldom does. A lookup
 * slower than `timeoutMs` (a first full scan of the sources) is not waited for:
 * the hover shows without it, and the locator keeps what it read for next time.
 */
export async function withSourceSummary(
  hover: HoverContent,
  locator: ClassLocator,
  timeoutMs: number,
): Promise<HoverContent> {
  if (hover.summary !== null) return hover;
  const lookup: Promise<string | null> =
    hover.kind !== 'field'
      ? locator.classSummary(hover.type)
      : hover.owner === null
        ? Promise.resolve(null)
        : locator
            .locateMember(hover.owner, hover.member)
            .then((members) => members.find((member) => member.summary)?.summary ?? null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)));
  const summary = await Promise.race([lookup.catch(() => null), timeout]).finally(() => clearTimeout(timer));
  return summary ? { ...hover, summary } : hover;
}

/** A summary, with the empty one the CLI may write read as none. */
function summaryOf(documented: { readonly summary?: string } | undefined): string | null {
  return documented?.summary || null;
}

/**
 * The hover as markdown: a C#-highlighted signature — a field's with its
 * default as an initializer — then the summary, escaped, since it is the
 * compiler's plain text and may hold `<`, `*` or `_`.
 */
export function hoverMarkdown(hover: HoverContent): string {
  const signature =
    hover.kind === 'field'
      ? `(field) ${hover.type} ${hover.name}${hover.default === null ? '' : ` = ${hover.default}`}`
      : `(${hover.kind}) ${hover.type}`;

  const parts = [['```csharp', signature, '```'].join('\n')];
  if (hover.summary) parts.push(escapeMarkdown(hover.summary));
  if (hover.kind === 'field' && hover.required) parts.push('*required*');
  return parts.join('\n\n');
}

/** Longest default shown in full; the IL scan can lift a whole collection literal. */
const MAX_DEFAULT_LENGTH = 120;

/** Field kinds whose string default is a member name, written bare in YAML. */
const NAMED_VALUE_KINDS = new Set(['enum', 'flags']);

/**
 * A field's default as text, or `null`. `hasDefault` alone is not enough: the
 * CLI sets it for initializers it saw but could not evaluate, and leaves
 * `default` out then.
 */
function defaultOf(field: FieldMetadata): string | null {
  if (!field.hasDefault || field.default === undefined) return null;
  const value = field.default;
  const text =
    typeof value === 'string' && NAMED_VALUE_KINDS.has(field.fieldKind) ? value : JSON.stringify(value);
  return text.length > MAX_DEFAULT_LENGTH ? `${text.slice(0, MAX_DEFAULT_LENGTH)}…` : text;
}

/** Markdown's ASCII punctuation escapes — what VS Code's `MarkdownString.appendText` escapes too. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// CLR type names
// ---------------------------------------------------------------------------

/** CLR types C# spells with a keyword. */
const KEYWORDS: Readonly<Record<string, string>> = {
  'System.Boolean': 'bool',
  'System.Byte': 'byte',
  'System.SByte': 'sbyte',
  'System.Char': 'char',
  'System.Int16': 'short',
  'System.UInt16': 'ushort',
  'System.Int32': 'int',
  'System.UInt32': 'uint',
  'System.Int64': 'long',
  'System.UInt64': 'ulong',
  'System.Single': 'float',
  'System.Double': 'double',
  'System.Decimal': 'decimal',
  'System.String': 'string',
  'System.Object': 'object',
};

const NULLABLE = 'System.Nullable`1';

/**
 * A CLR full type name as C# writes it, namespaces dropped:
 * ``System.Collections.Generic.List`1[[Content.Server….DamageThreshold, Content.Server, Version=…]]``
 * -> `List<DamageThreshold>`. Generic arguments arrive assembly-qualified; a
 * nested type's `+` becomes `.`; `Nullable<T>` is `T?`. A name this cannot read
 * comes back unchanged.
 */
export function readableTypeName(fullName: string): string {
  const parsed = parseClrType(fullName, 0);
  return parsed && parsed.end === fullName.length ? parsed.name : fullName;
}

/** One type name starting at `start`, read up to where it ends — `end` is the index past it. */
function parseClrType(text: string, start: number): { name: string; end: number } | null {
  let at = start;
  while (at < text.length && !'[],'.includes(text[at])) at++;
  const raw = text.slice(start, at).trim();
  if (!raw) return null;

  // Generic arguments: `[[Arg, Assembly…],[Arg, Assembly…]]`.
  const args: string[] = [];
  if (text[at] === '[' && text[at + 1] === '[') {
    at++;
    for (;;) {
      if (text[at] !== '[') return null;
      const arg = parseClrType(text, at + 1);
      if (!arg) return null;
      // Skip the assembly qualification; it holds no brackets.
      const close = text.indexOf(']', arg.end);
      if (close === -1) return null;
      args.push(arg.name);
      at = close + 1;
      if (text[at] === ',') at++;
      else if (text[at] === ']') {
        at++;
        break;
      } else return null;
    }
  }

  // Array ranks: `[]`, `[,]`, repeated for jagged arrays.
  let ranks = '';
  while (text[at] === '[' && (text[at + 1] === ']' || text[at + 1] === ',')) {
    let close = at + 1;
    while (text[close] === ',') close++;
    if (text[close] !== ']') return null;
    ranks += text.slice(at, close + 1);
    at = close + 1;
  }

  return { name: `${typeNameOf(raw, args)}${ranks}`, end: at };
}

function typeNameOf(raw: string, args: readonly string[]): string {
  if (raw === NULLABLE && args.length === 1) return `${args[0]}?`;
  if (KEYWORDS[raw]) return KEYWORDS[raw];

  // The namespace ends at the last `.` before any nested-type `+`.
  const nested = raw.indexOf('+');
  const namespaceEnd = (nested === -1 ? raw : raw.slice(0, nested)).lastIndexOf('.');
  const name = raw
    .slice(namespaceEnd + 1)
    .replace(/`\d+/g, '')
    .replace(/\+/g, '.');
  return args.length > 0 ? `${name}<${args.join(', ')}>` : name;
}
