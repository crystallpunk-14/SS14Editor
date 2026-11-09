/**
 * Where a C# type, or a field or property of one, is declared in the fork (spec
 * #20, "Текстовые провайдеры"; issue #31) — the target of go-to-definition on a
 * component name, a `!type:` tag, a prototype's `type:` and a field key.
 *
 * The schema names each class (`ComponentMetadata.className`, a field's
 * `declaringType`, …) but not its source file: the extractor reads compiled
 * DLLs, and their PDBs carry sequence points for method bodies only — a type's
 * own declaration line is not in them, and a component with no methods has no
 * entry at all. So the declaration is looked up in source instead — `class`,
 * `struct` or `record <Name>`, then a member in its body — over the fork's
 * git-tracked `.cs` files in the `Content.*` projects and the engine's
 * `RobustToolbox/Robust.*` (a submodule, listed with `--recurse-submodules`).
 *
 * Pure core over {@link CsSourceTree}: the host answers "which files" and "what
 * is in this one"; matching, comment/string scrubbing and caching live here, and
 * the result is a fork-relative path plus an offset as data.
 */

/** The fork's C# sources as the locator needs them. Paths are fork-relative and `/`-separated. */
export interface CsSourceTree {
  /** Git-tracked `.cs` files (submodules included); `undefined` when they cannot be listed. */
  listFiles(): Promise<readonly string[] | undefined>;
  /** A file's text; `undefined` when it cannot be read. */
  readFile(path: string): Promise<string | undefined>;
}

/** One `class <name>` in a file. */
export interface ClassDeclaration {
  readonly name: string;
  /** Enclosing namespace, dotted; `null` for the global namespace. */
  readonly namespace: string | null;
  /** Offset of the class name in the BOM-stripped text. */
  readonly offset: number;
}

/** A declaration to jump to: fork-relative file plus where the class name is written. */
export interface ClassLocation {
  readonly filePath: string;
  /** Offset of the class name in the BOM-stripped text. */
  readonly offset: number;
  /** The class name as declared — its short name, `[offset, offset + name.length)`. */
  readonly name: string;
}

/** The C# projects a component can live in: content projects and the engine submodule's. */
const PROJECT_FILE = /^(?:Content\.[^/]+|RobustToolbox\/Robust\.[^/]+)\/.+\.cs$/;

/** Files read at once during a full scan. */
const SCAN_BATCH = 64;

const BOM = 0xfeff;

/**
 * Finds class declarations by full name, caching what it reads. One instance
 * serves one schema: the host drops it when the schema changes, which is when
 * classes may have moved.
 *
 * A lookup first reads only the files named after the class (`FooComponent.cs`,
 * and partial parts like `FooComponent.Server.cs`) — where SS14 keeps nearly
 * every component — or, for a nested class, after its outermost one. Only when none of those declares it does it scan every file,
 * once; that scan is kept for later misses.
 */
export class ClassLocator {
  private files: readonly string[] | undefined;
  private readonly declarations = new Map<string, Promise<readonly ClassDeclaration[]>>();
  private fullScan: Promise<void> | undefined;

  constructor(private readonly source: CsSourceTree) {}

  /**
   * Every declaration of `fullName` (`Namespace.Class`, or `Namespace.Outer+Inner`
   * for a nested class) — more than one for a partial class. Empty when it is not
   * declared in the fork's sources, or they cannot be listed.
   */
  async locate(fullName: string): Promise<ClassLocation[]> {
    const { namespace, name, outermost } = splitClassName(fullName.replace(GENERIC_ARITY, ''));
    const files = await this.projectFiles();
    if (files.length === 0) return [];

    const namedFiles = files.filter((path) => isNamedAfter(path, name) || isNamedAfter(path, outermost));
    const byFileName = await this.matchesIn(namedFiles, name, namespace);
    if (byFileName.length > 0) return byFileName;

    await this.scanAll(files);
    return this.matchesIn(files, name, namespace);
  }

  /**
   * The `/// <summary>` of `fullName`'s declaration — the first part of a
   * partial class that has one — as plain text; `null` when none does. What
   * hover shows when the schema carries no summary: forks rarely build XML docs.
   */
  async classSummary(fullName: string): Promise<string | null> {
    for (const location of await this.locate(fullName)) {
      const text = await this.textOf(location.filePath);
      const summary = text === undefined ? null : docSummaryBefore(text, location.offset);
      if (summary) return summary;
    }
    return null;
  }

  /**
   * The `/// <summary>` of the field or property `member` in the class
   * `fullName` that declares it; `null` when it has none or is not found there.
   */
  async memberSummary(fullName: string, member: string): Promise<string | null> {
    for (const location of await this.locate(fullName)) {
      const text = await this.textOf(location.filePath);
      const offset = text === undefined ? null : memberDeclarationIn(text, location.offset, member);
      const summary = text === undefined || offset === null ? null : docSummaryBefore(text, offset);
      if (summary) return summary;
    }
    return null;
  }

  /**
   * Where `member` (a field or property, by its C# name) is declared in the class
   * `fullName` — one location per part of a partial class that declares it. When
   * no part does (the member is generated, or the sources drifted from the
   * build), the class's own declarations instead, so the link still lands near.
   * Empty when the class itself is not found.
   */
  async locateMember(fullName: string, member: string): Promise<ClassLocation[]> {
    const classes = await this.locate(fullName);
    const members = await Promise.all(
      classes.map(async (location): Promise<ClassLocation | null> => {
        const text = await this.textOf(location.filePath);
        const offset = text === undefined ? null : memberDeclarationIn(text, location.offset, member);
        return offset === null ? null : { filePath: location.filePath, offset, name: member };
      }),
    );
    const found = members.filter((location) => location !== null);
    return found.length > 0 ? found : classes;
  }

  private async projectFiles(): Promise<readonly string[]> {
    if (this.files) return this.files;
    const listed = await this.source.listFiles().catch(() => undefined);
    // A failed listing is not kept: the next request asks git again.
    if (!listed) return [];
    this.files = listed.filter((path) => PROJECT_FILE.test(path));
    return this.files;
  }

  private async matchesIn(files: readonly string[], name: string, namespace: string | null): Promise<ClassLocation[]> {
    const perFile = await Promise.all(files.map((path) => this.declarationsOf(path)));
    return files.flatMap((filePath, i) =>
      perFile[i]
        .filter((decl) => decl.name === name && decl.namespace === namespace)
        .map((decl) => ({ filePath, offset: decl.offset, name })),
    );
  }

  private scanAll(files: readonly string[]): Promise<void> {
    this.fullScan ??= (async () => {
      for (let i = 0; i < files.length; i += SCAN_BATCH) {
        await Promise.all(files.slice(i, i + SCAN_BATCH).map((path) => this.declarationsOf(path)));
      }
    })();
    return this.fullScan;
  }

  private declarationsOf(path: string): Promise<readonly ClassDeclaration[]> {
    let found = this.declarations.get(path);
    if (!found) {
      found = this.textOf(path).then((text) => (text === undefined ? [] : classDeclarationsIn(text)));
      this.declarations.set(path, found);
    }
    return found;
  }

  /** A file's text, read afresh: only the declarations are kept, not whole files. */
  private textOf(path: string): Promise<string | undefined> {
    return this.source.readFile(path).catch(() => undefined);
  }
}

/** A generic type's arity suffix in a CLR name, `` `1 `` — source declares `Name<T>`. */
const GENERIC_ARITY = /`\d+/g;

/** `A.B.Outer+Inner` -> namespace `A.B`, name `Inner`, outermost class `Outer`. */
function splitClassName(fullName: string): { namespace: string | null; name: string; outermost: string } {
  const plus = fullName.lastIndexOf('+');
  const outer = plus < 0 ? fullName : fullName.slice(0, fullName.indexOf('+'));
  const dot = outer.lastIndexOf('.');
  return {
    namespace: dot < 0 ? null : outer.slice(0, dot),
    name: plus < 0 ? fullName.slice(dot + 1) : fullName.slice(plus + 1),
    outermost: outer.slice(dot + 1),
  };
}

/** `…/FooComponent.cs` or a partial part `…/FooComponent.Server.cs`. */
function isNamedAfter(path: string, name: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base === `${name}.cs` || base.startsWith(`${name}.`);
}

/**
 * `namespace X;`, `namespace X {`, a type declaration — `class Name`,
 * `struct Name`, `record Name`, `record struct Name` (`record class` is
 * covered by `class`) — or a lone brace, over text whose comments and string
 * literals are already blanked, so none of these can match inside them. A
 * `where T : class` / `struct` constraint followed by another `where`, and a
 * variable named `record` (`foreach (var record in …)`), are not declarations.
 * A `[DataDefinition]` may be any of these, so any is a "class" to the locator.
 */
const TOKEN =
  /\bnamespace\s+([A-Za-z_][\w.]*)\s*([;{])|\b(?:class|struct|record(?:\s+struct)?)\s+(?!where\b|class\b|in\b)([A-Za-z_]\w*)|[{}]/g;

/**
 * A file's code as the scanners read it: BOM stripped — offsets are into the
 * BOM-stripped text — and comments and literals blanked.
 */
function scrubbed(rawText: string): string {
  return blankCommentsAndStrings(rawText.charCodeAt(0) === BOM ? rawText.slice(1) : rawText);
}

/**
 * The class declarations of one C# file, each with its enclosing namespace —
 * file-scoped or (nested) block-scoped. `class` inside a comment, string, or
 * char literal is not a declaration.
 */
export function classDeclarationsIn(rawText: string): ClassDeclaration[] {
  const code = scrubbed(rawText);

  const found: ClassDeclaration[] = [];
  let fileScoped: string | null = null;
  const blocks: { name: string; depth: number }[] = [];
  let depth = 0;

  for (const match of code.matchAll(TOKEN)) {
    const [token, nsName, nsEnd, className] = match;
    if (nsName !== undefined) {
      if (nsEnd === ';') {
        fileScoped = nsName;
      } else {
        blocks.push({ name: nsName, depth });
        depth++;
      }
    } else if (className !== undefined) {
      const parts = [...(fileScoped === null ? [] : [fileScoped]), ...blocks.map((b) => b.name)];
      found.push({
        name: className,
        namespace: parts.length > 0 ? parts.join('.') : null,
        offset: match.index + token.length - className.length,
      });
    } else if (token === '{') {
      depth++;
    } else {
      depth--;
      if (blocks.length > 0 && blocks[blocks.length - 1].depth === depth) blocks.pop();
    }
  }
  return found;
}

/**
 * Offset of the declaration of field or property `member` directly in the body
 * of the class whose name sits at `classOffset` (as {@link classDeclarationsIn}
 * reports it), or `null` when that body declares none.
 *
 * The body is read member by member — the text between `;`, `{` and `}` at the
 * body's own depth, so a nested class or a property body is never mistaken for
 * it. In one member, the name declares it when it is followed by `;`, `=`, `{`,
 * `=>` or `,` and nothing before it is an initializer or an open parameter
 * list: `int X;`, `T? X { get; }`, `List<T> X = new();`, `(int, int) X;`,
 * `int A, X;`, `int IFoo.X { get; }` and `@event` are declarations, while
 * `float B = (float) X;`, `int Y => _a ?? X;` and `void F(int X = 1)` are not.
 * Attributes are read past. Comments and string literals are skipped.
 */
export function memberDeclarationIn(rawText: string, classOffset: number, member: string): number | null {
  // A C# member name is an identifier: nothing in it needs escaping.
  if (!/^\w+$/.test(member)) return null;
  const code = scrubbed(rawText);

  const open = code.indexOf('{', classOffset);
  // `record Foo(int X);` — a body-less declaration has no members to find.
  const semicolon = code.indexOf(';', classOffset);
  if (open < 0 || (semicolon >= 0 && semicolon < open)) return null;

  const token = new RegExp(String.raw`[{};]|@?\b${member}\b(?=\s*(?:[;={,]|=>))`, 'g');
  token.lastIndex = open + 1;

  let depth = 1;
  let memberStart = open + 1;
  for (let match = token.exec(code); match; match = token.exec(code)) {
    const [found] = match;
    if (found === '{') {
      depth++;
    } else if (found === '}') {
      if (--depth === 0) return null;
      if (depth === 1) memberStart = match.index + 1;
    } else if (found === ';') {
      if (depth === 1) memberStart = match.index + 1;
    } else if (depth === 1 && isDeclaratorHead(code.slice(memberStart, match.index))) {
      return found.startsWith('@') ? match.index + 1 : match.index;
    }
  }
  return null;
}

/**
 * Whether `head` — one member's text up to a candidate name — leaves that name
 * in declarator position: right after a type and whitespace, an earlier
 * declarator's `,`, or an interface's `IFoo.`; with no `=` and no unclosed `(`
 * on the way.
 */
function isDeclaratorHead(head: string): boolean {
  // Attribute lists and array ranks hold `=` and `(` of their own.
  const bare = head.replace(/\[[^\]]*\]/g, ' ').trimEnd();
  if (bare.includes('=')) return false;
  if (count(bare, '(') !== count(bare, ')')) return false;

  const last = bare.at(-1);
  if (last === '.' || last === ',') return true;
  // `int X`, `T? X`, `List<T> X`, `(int, int) X`.
  return last !== undefined && /[\w?)>]/.test(last) && /\s$/.test(head);
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/**
 * `text` with every comment and string/char literal replaced by spaces (line
 * breaks kept), so offsets still line up. Handles `//`, `/* *\/`, `"…"` with
 * escapes, verbatim `@"…"` with `""`, raw `"""…"""`, and interpolated `$"…"` —
 * whose `{…}` holes are code and may hold strings of their own
 * (`$"{Loc.GetString("id")}"`), so they are walked rather than skipped.
 */
function blankCommentsAndStrings(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };

  /** Walk code from `i`. In a hole, stop after the `}` that closes it and return that index. */
  const walkCode = (start: number, inHole: boolean): number => {
    let i = start;
    let braces = 0;
    while (i < text.length) {
      const c = text[i];
      const next = text[i + 1];
      if (c === '/' && next === '/') {
        const end = lineEnd(text, i);
        blank(i, end);
        i = end;
      } else if (c === '/' && next === '*') {
        const close = text.indexOf('*/', i + 2);
        const end = close < 0 ? text.length : close + 2;
        blank(i, end);
        i = end;
      } else if (c === "'") {
        const end = charLiteralEnd(text, i);
        blank(i, end);
        i = end;
      } else if (c === '"' || c === '$' || c === '@') {
        i = stringAt(i);
      } else {
        if (inHole && c === '{') braces++;
        if (inHole && c === '}') {
          if (braces === 0) return i + 1;
          braces--;
        }
        i++;
      }
    }
    return i;
  };

  /** A string literal starting at `start` (prefix included), blanked; returns the index after it. */
  const stringAt = (start: number): number => {
    let i = start;
    let interpolated = false;
    let verbatim = false;
    while (text[i] === '$' || text[i] === '@') {
      if (text[i] === '$') interpolated = true;
      else verbatim = true;
      i++;
    }
    // A `$`/`@` not opening a string (`@class`) is ordinary code.
    if (text[i] !== '"') return start + 1;

    let quotes = 0;
    while (text[i + quotes] === '"') quotes++;
    if (quotes >= 3) {
      // Raw string: closed by the same run of quotes. Holes are not walked —
      // a hole cannot hold a run that long without being a raw string itself.
      const close = text.indexOf('"'.repeat(quotes), i + quotes);
      const end = close < 0 ? text.length : close + quotes;
      blank(start, end);
      return end;
    }

    i++;
    let segment = start;
    while (i < text.length) {
      const c = text[i];
      if (!verbatim && c === '\\') {
        i += 2;
      } else if (c === '"') {
        if (verbatim && text[i + 1] === '"') {
          i += 2;
        } else {
          blank(segment, i + 1);
          return i + 1;
        }
      } else if (interpolated && c === '{') {
        if (text[i + 1] === '{') {
          i += 2;
          continue;
        }
        blank(segment, i + 1);
        const end = walkCode(i + 1, true);
        blank(end - 1, end);
        i = end;
        segment = end;
      } else if (!verbatim && c === '\n') {
        // Unterminated: a regular string cannot span lines.
        break;
      } else {
        i++;
      }
    }
    blank(segment, i);
    return i;
  };

  walkCode(0, false);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Doc comments
// ---------------------------------------------------------------------------

/**
 * The `/// <summary>` written above the declaration at `offset` — over its
 * attributes, which may span lines — as plain text: tags dropped, a
 * `<see cref>` reduced to its short name, whitespace collapsed. `null` when
 * there is none, or it is only `<inheritdoc/>`. `offset` is into the BOM-stripped text.
 */
export function docSummaryBefore(rawText: string, offset: number): string | null {
  const text = rawText.charCodeAt(0) === BOM ? rawText.slice(1) : rawText;
  const lines = text.slice(0, offset).split('\n');
  lines.pop(); // the declaration's own line, up to the name
  const doc: string[] = [];
  let brackets = 0;
  while (lines.length > 0) {
    const line = (lines.pop() ?? '').trim();
    if (line.startsWith('///')) {
      if (brackets > 0) break;
      doc.unshift(line.slice(3));
      continue;
    }
    if (doc.length > 0) break;
    brackets += count(line, ']') - count(line, '[');
    // An attribute line, part of one, or a plain comment or directive among them.
    if (brackets > 0 || line.startsWith('[') || line.startsWith('//') || line.startsWith('#')) continue;
    break;
  }
  if (doc.length === 0) return null;

  const xml = doc.join('\n');
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(xml)?.[1] ?? (/<\w/.test(xml) ? '' : xml);
  const plain = summary
    .replace(/<see(?:also)?\s+(?:cref|href)="(?:\w:)?([^"]*)"\s*\/>/g, (_, ref: string) => shortRef(ref))
    .replace(/<(?:see|paramref|typeparamref)\s+(?:langword|name)="([^"]*)"\s*\/>/g, '$1')
    // Block tags part words; inline ones (`<c>`, `<b>`) wrap them.
    .replace(/<\/?(?:para|br|list|item|description|term)\b[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return plain || null;
}

/** A `cref` as its short name: `Content.Shared.Foo.BarComponent` -> `BarComponent`, `M:A.B.Run(int)` -> `Run`. */
function shortRef(ref: string): string {
  const bare = ref.replace(/[({].*$/, '').replace(/`\d+/g, '');
  return bare.slice(bare.lastIndexOf('.') + 1);
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf('\n', from);
  return end < 0 ? text.length : end;
}

/** The index after a char literal at `start` (`'x'`, `'\n'`, `'\''`); just past a stray `'`. */
function charLiteralEnd(text: string, start: number): number {
  const close = text[start + 1] === '\\' ? start + 3 : start + 2;
  if (text[close] === "'") return close + 1;
  // `'A'` and other long escapes.
  const far = text.indexOf("'", start + 1);
  return far > 0 && far - start <= 10 && !text.slice(start, far).includes('\n') ? far + 1 : start + 1;
}
