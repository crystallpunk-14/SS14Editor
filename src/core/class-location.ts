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
 * every component. Only when none of those declares it does it scan every file,
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
    const { namespace, name } = splitClassName(fullName);
    const files = await this.projectFiles();
    if (files.length === 0) return [];

    const namedFiles = files.filter((path) => isNamedAfter(path, name));
    const byFileName = await this.matchesIn(namedFiles, name, namespace);
    if (byFileName.length > 0) return byFileName;

    await this.scanAll(files);
    return this.matchesIn(files, name, namespace);
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
      found = this.source
        .readFile(path)
        .catch(() => undefined)
        .then((text) => (text === undefined ? [] : classDeclarationsIn(text)));
      this.declarations.set(path, found);
    }
    return found;
  }
}

/** `A.B.Outer+Inner` -> namespace `A.B`, name `Inner`. */
function splitClassName(fullName: string): { namespace: string | null; name: string } {
  const plus = fullName.lastIndexOf('+');
  const outer = plus < 0 ? fullName : fullName.slice(0, fullName.indexOf('+'));
  const dot = outer.lastIndexOf('.');
  return {
    namespace: dot < 0 ? null : outer.slice(0, dot),
    name: plus < 0 ? fullName.slice(dot + 1) : fullName.slice(plus + 1),
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
