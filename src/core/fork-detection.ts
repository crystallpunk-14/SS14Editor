/**
 * Fork detection — pure core (spec #20, "Обнаружение форка"; issue #23).
 *
 * Decides whether a single workspace-folder root *is itself* a built SS14 fork,
 * and if not, *why*. All I/O is abstracted behind {@link ForkFs} so the rules
 * are tested over a fake directory, never the real filesystem. The host adapter
 * ({@link file://../host/fork-fs.ts}) is the only place a real FS is wired in.
 *
 * Rules, straight from the spec:
 *   - Mandatory signals, all at once, directly at the root — no tree walk, no
 *     `.sln` check: a `RobustToolbox` submodule in `.gitmodules`, and the
 *     directories `Content.Server/`, `Content.Client/`, `Resources/Prototypes/`.
 *   - Schema DLLs live only in `bin/Content.Server/` and `bin/Content.Client/`
 *     (the upstream `OutputPath` convention) — not a per-project `bin`, not `obj`.
 *   - Build freshness: the newest DLL in `bin/Content.<X>/` should be no older
 *     than the newest **git-tracked** `.cs` under `Content.<X>/`. A raw file
 *     walk would trip over generated `AssemblyInfo.cs`; `git ls-files` is the
 *     oracle. If git can't answer, staleness is treated as unprovable.
 *     A stale build is a warning, not a blocker: its DLLs are the last good
 *     build, and the schema read from them keeps every feature working — a
 *     `git pull` without a rebuild must not silence the editor.
 */

/** The slice of a directory the detector needs, all paths relative to the fork root. */
export interface ForkFs {
  /** True when a directory exists at `relPath`. */
  dirExists(relPath: string): boolean;
  /** UTF-8 contents of the file at `relPath`, or `undefined` if it is absent/unreadable. */
  readFile(relPath: string): string | undefined;
  /** Entry names directly inside `relPath` (files and dirs, one level); `[]` if it is not a directory. */
  listDir(relPath: string): string[];
  /** Modification time of `relPath` in epoch milliseconds, or `undefined` if absent. */
  mtimeMs(relPath: string): number | undefined;
  /**
   * Root-relative paths of git-tracked files under `relPath` (as `git ls-files -- <relPath>`
   * reports them). `undefined` means git is unavailable or this is not a repo.
   */
  gitLsFiles(relPath: string): string[] | undefined;
}

export type ForkProblemCode =
  | 'no-robusttoolbox-submodule'
  | 'no-content-server'
  | 'no-content-client'
  | 'no-resources-prototypes'
  | 'dlls-not-found';

export interface ForkRecognized {
  recognized: true;
  /** Set when C# sources are newer than the built DLLs; the fork still works off the last build. */
  stale?: StaleBuild;
}

/** A build behind its sources — shown as a warning, never a blocker. */
export interface StaleBuild {
  /** Which `Content.*` projects have sources newer than their DLLs. */
  projects: string[];
  /** Human-readable warning, logged verbatim. */
  message: string;
}

export interface ForkUnrecognized {
  recognized: false;
  code: ForkProblemCode;
  /** Human-readable, user-facing explanation of the single blocking reason. */
  message: string;
}

export type ForkStatus = ForkRecognized | ForkUnrecognized;

/** The workspace folder that was checked, plus the verdict for it. */
export interface ForkFolderStatus {
  name: string;
  status: ForkStatus;
}

/** The two projects whose DLLs the schema extractor reads, in check order. */
const CONTENT_PROJECTS = ['Content.Server', 'Content.Client'] as const;

/**
 * Classify one fork-root candidate. Checks run in the order the spec lists the
 * signals, so when several things are wrong the earliest (most fundamental) one
 * is what gets reported.
 */
export function detectFork(fs: ForkFs): ForkStatus {
  const gitmodules = fs.readFile('.gitmodules');
  if (gitmodules === undefined || !declaresRobustToolboxSubmodule(gitmodules)) {
    return problem(
      'no-robusttoolbox-submodule',
      'Not an SS14 fork: no "RobustToolbox" submodule is declared in .gitmodules.',
    );
  }

  if (!fs.dirExists('Content.Server')) {
    return problem(
      'no-content-server',
      'Not an SS14 fork: no Content.Server/ directory at the workspace root.',
    );
  }

  if (!fs.dirExists('Content.Client')) {
    return problem(
      'no-content-client',
      'Not an SS14 fork: no Content.Client/ directory at the workspace root.',
    );
  }

  if (!fs.dirExists('Resources/Prototypes')) {
    return problem(
      'no-resources-prototypes',
      'Not an SS14 fork: no Resources/Prototypes/ directory at the workspace root.',
    );
  }

  const dllMtimes = CONTENT_PROJECTS.map((project) => newestDllMtime(fs, project));
  if (dllMtimes.some((mtime) => mtime === undefined)) {
    return problem(
      'dlls-not-found',
      'Fork not built: no DLLs in bin/Content.Server/ or bin/Content.Client/. Build the fork, then reopen the folder.',
    );
  }

  const staleProjects = CONTENT_PROJECTS.filter((project, index) => {
    const newestSource = newestTrackedCsMtime(fs, project);
    return newestSource !== undefined && dllMtimes[index]! < newestSource;
  });
  if (staleProjects.length > 0) {
    return {
      recognized: true,
      stale: {
        projects: staleProjects,
        message:
          `⚠ Fork build is stale: ${staleProjects.join(', ')} C# source is newer than the DLLs in bin/. ` +
          'The schema comes from the last build — rebuild the fork to pick up the changes.',
      },
    };
  }

  return { recognized: true };
}

/** True when `.gitmodules` declares a submodule checked out at path `RobustToolbox`. */
function declaresRobustToolboxSubmodule(gitmodules: string): boolean {
  return /^\s*path\s*=\s*RobustToolbox\s*$/m.test(gitmodules);
}

/** Newest mtime among `bin/<project>/*.dll`, or `undefined` when there are none. */
function newestDllMtime(fs: ForkFs, project: string): number | undefined {
  const dir = `bin/${project}`;
  const dllPaths = fs
    .listDir(dir)
    .filter((name) => name.toLowerCase().endsWith('.dll'))
    .map((name) => `${dir}/${name}`);
  return newestMtime(fs, dllPaths);
}

/**
 * Newest mtime among git-tracked `.cs` files under `<project>/`. Returns
 * `undefined` when git is unavailable (staleness unprovable) or nothing is
 * tracked — never counts an untracked generated file such as `AssemblyInfo.cs`.
 */
function newestTrackedCsMtime(fs: ForkFs, project: string): number | undefined {
  const tracked = fs.gitLsFiles(project);
  if (tracked === undefined) return undefined;
  return newestMtime(
    fs,
    tracked.filter((relPath) => relPath.toLowerCase().endsWith('.cs')),
  );
}

/** Largest mtime among the given paths, or `undefined` if none of them resolve. */
function newestMtime(fs: ForkFs, relPaths: string[]): number | undefined {
  let newest: number | undefined;
  for (const relPath of relPaths) {
    const mtime = fs.mtimeMs(relPath);
    if (mtime !== undefined && (newest === undefined || mtime > newest)) newest = mtime;
  }
  return newest;
}

function problem(code: ForkProblemCode, message: string): ForkUnrecognized {
  return { recognized: false, code, message };
}
