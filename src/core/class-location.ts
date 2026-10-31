/**
 * Where a C# class is declared in the fork (spec #20, "Текстовые провайдеры";
 * issue #31) — the target of go-to-definition on a component name.
 *
 * The schema names each component's class (`ComponentMetadata.className`) but
 * not its source file: the extractor reads compiled DLLs, and their PDBs carry
 * sequence points for method bodies only — a type's own declaration line is not
 * in them, and a component with no methods has no entry at all. So the
 * declaration is looked up in source instead: `class <Name>` over the fork's
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

/** A member declaration to jump to: fork-relative file plus where its name is written. */
export interface MemberLocation extends ClassLocation {
  /** Its `/// <summary>` as plain text, or `null` when it has none. */
  readonly summary: string | null;
}

/** Base classes followed when a field is not declared on its owner itself. */
const MAX_BASE_DEPTH = 8;

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
    const { namespace, name, outermost } = splitClassName(fullName);
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
   * Where the field or property `member` of class `fullName` is declared — on
   * the class itself (any part of it) or, failing that, on its base classes,
   * which are looked up by short name. Empty when it is found on none.
   */
  async locateMember(fullName: string, member: string): Promise<MemberLocation[]> {
    let classes: ClassLocation[] = await this.locate(fullName);
    const seen = new Set<string>();
    for (let depth = 0; depth <= MAX_BASE_DEPTH && classes.length > 0; depth++) {
      const bases = new Set<string>();
      const found: MemberLocation[] = [];
      for (const location of classes) {
        const text = await this.textOf(location.filePath);
        if (text === undefined) continue;
        const offset = memberOffsetIn(text, location.offset, member);
        if (offset !== null) {
          found.push({ filePath: location.filePath, offset, name: member, summary: docSummaryBefore(text, offset) });
        }
        const base = baseClassOf(text, location.offset);
        if (base !== null && !seen.has(base)) bases.add(base);
      }
      if (found.length > 0) return found;
      for (const base of bases) seen.add(base);
      classes = (await Promise.all([...bases].map((base) => this.locateShortName(base)))).flat();
    }
    return [];
  }

  /** Every declaration of a class by its short name, in any namespace. */
  private async locateShortName(name: string): Promise<ClassLocation[]> {
    const files = await this.projectFiles();
    const named = await this.matchesIn(
      files.filter((path) => isNamedAfter(path, name)),
      name,
      undefined,
    );
    if (named.length > 0) return named;
    await this.scanAll(files);
    return this.matchesIn(files, name, undefined);
  }

  /** A file's BOM-stripped text — the text declaration offsets are into. */
  private async textOf(path: string): Promise<string | undefined> {
    const text = await this.source.readFile(path).catch(() => undefined);
    return text !== undefined && text.charCodeAt(0) === BOM ? text.slice(1) : text;
  }

  private async projectFiles(): Promise<readonly string[]> {
    if (this.files) return this.files;
    const listed = await this.source.listFiles().catch(() => undefined);
    // A failed listing is not kept: the next request asks git again.
    if (!listed) return [];
    this.files = listed.filter((path) => PROJECT_FILE.test(path));
    return this.files;
  }

  /** Declarations of `name` in `files`; in `namespace` only, unless that is `undefined`. */
  private async matchesIn(
    files: readonly string[],
    name: string,
    namespace: string | null | undefined,
  ): Promise<ClassLocation[]> {
    const perFile = await Promise.all(files.map((path) => this.declarationsOf(path)));
    return files.flatMap((filePath, i) =>
      perFile[i]
        .filter((decl) => decl.name === name && (namespace === undefined || decl.namespace === namespace))
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
      found = this.source
        .readFile(path)
        .catch(() => undefined)
        .then((text) => (text === undefined ? [] : classDeclarationsIn(text)));
      this.declarations.set(path, found);
    }
    return found;
  }
}

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
 * `namespace X;`, `namespace X {`, `class Name`, or a lone brace — over text
 * whose comments and string literals are already blanked, so none of these can
 * match inside them. `record class` is covered by `class`; a `where T : class`
 * constraint followed by another `where` is not a declaration.
 */
const TOKEN = /\bnamespace\s+([A-Za-z_][\w.]*)\s*([;{])|\bclass\s+(?!where\b)([A-Za-z_]\w*)|[{}]/g;

/**
 * The class declarations of one C# file, each with its enclosing namespace —
 * file-scoped or (nested) block-scoped. `class` inside a comment, string, or
 * char literal is not a declaration.
 */
export function classDeclarationsIn(rawText: string): ClassDeclaration[] {
  const text = rawText.charCodeAt(0) === BOM ? rawText.slice(1) : rawText;
  const code = blankCommentsAndStrings(text);

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
// Members, base classes and doc comments
// ---------------------------------------------------------------------------

/**
 * Offset of the field or property `member` declared directly in the class body
 * whose name is at `classOffset` — at the body's own brace depth, so a local or
 * a statement inside a method never counts. `null` when the body declares none.
 * `text` is BOM-stripped.
 */
export function memberOffsetIn(text: string, classOffset: number, member: string): number | null {
  const code = blankCommentsAndStrings(text);
  const open = bodyStart(code, classOffset);
  if (open === null) return null;

  // A name after a type (`string? Sprite`, `List<int> Ids`, `int[] Ids`) and
  // before an initializer, `;`, a property's accessors or `=>`.
  const declaration = new RegExp(String.raw`[\w>\]?]\s+(${escapeRegExp(member)})\s*(?:[=;{]|=>)`, 'y');
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return null;
    } else if (depth === 1) {
      declaration.lastIndex = i;
      const match = declaration.exec(code);
      // Past the type's last character and the whitespace, the name is the first thing.
      if (match) return match.index + match[0].indexOf(member, 1);
    }
  }
  return null;
}

/**
 * The short name of the class the declaration at `classOffset` derives from —
 * the first entry of its base list, generic arguments and namespace dropped —
 * or `null` when it has none, or the first entry is an interface (`IFoo`).
 */
export function baseClassOf(text: string, classOffset: number): string | null {
  const code = blankCommentsAndStrings(text);
  const open = bodyStart(code, classOffset);
  const header = code.slice(classOffset, open ?? undefined);
  const colon = topLevelIndexOf(header, ':');
  if (colon < 0) return null;
  const list = header.slice(colon + 1).split(/\bwhere\b/)[0];
  const comma = topLevelIndexOf(list, ',');
  const first = (comma < 0 ? list : list.slice(0, comma)).replace(/<[\s\S]*$/, '').trim();
  const name = first.slice(first.lastIndexOf('.') + 1);
  if (!/^[A-Za-z_]\w*$/.test(name) || /^I[A-Z]/.test(name)) return null;
  return name;
}

/**
 * The `/// <summary>` written above the declaration at `offset` — over its
 * attributes, which may span lines — as plain text: tags dropped, a
 * `<see cref>` reduced to its short name, whitespace collapsed. `null` when
 * there is none, or it is only `<inheritdoc/>`. `text` is BOM-stripped.
 */
export function docSummaryBefore(text: string, offset: number): string | null {
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

/** Index of the `{` opening the body of the class named at `classOffset`; `null` for none (`record R(int A);`). */
function bodyStart(code: string, classOffset: number): number | null {
  for (let i = classOffset; i < code.length; i++) {
    if (code[i] === '{') return i;
    if (code[i] === ';') return null;
  }
  return null;
}

/** First `char` in `text` outside `<…>` and `(…)`, or -1. */
function topLevelIndexOf(text: string, char: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<' || c === '(') depth++;
    else if (c === '>' || c === ')') depth--;
    else if (c === char && depth === 0) return i;
  }
  return -1;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
