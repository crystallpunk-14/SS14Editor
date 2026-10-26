import { describe, expect, it } from 'vitest';

import { detectFork, type ForkFs } from '../../src/core/fork-detection';

/**
 * A fake {@link ForkFs} built from a plain description of a directory tree.
 * `files` maps a root-relative path to either an mtime (ms) or `{ mtimeMs, text }`.
 * `tracked` maps a directory to the git-tracked paths under it; `null` models
 * git being unavailable entirely.
 */
interface FakeForkSpec {
  dirs?: string[];
  files?: Record<string, number | { mtimeMs?: number; text?: string }>;
  gitmodules?: string | null;
  tracked?: Record<string, string[]> | null;
}

function fakeForkFs(spec: FakeForkSpec): ForkFs {
  const dirs = new Set(spec.dirs ?? []);
  const files = new Map<string, { mtimeMs?: number; text?: string }>();
  for (const [path, value] of Object.entries(spec.files ?? {})) {
    files.set(path, typeof value === 'number' ? { mtimeMs: value } : value);
  }
  if (spec.gitmodules != null) files.set('.gitmodules', { text: spec.gitmodules });

  return {
    dirExists: (relPath) => dirs.has(relPath),
    readFile: (relPath) => files.get(relPath)?.text,
    listDir: (relPath) => {
      const prefix = relPath === '' ? '' : `${relPath}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.length > 0 && !rest.includes('/')) names.add(rest);
      }
      return [...names];
    },
    mtimeMs: (relPath) => files.get(relPath)?.mtimeMs,
    gitLsFiles: (relPath) => {
      if (spec.tracked === null) return undefined;
      return spec.tracked?.[relPath] ?? [];
    },
  };
}

const T0 = 1_700_000_000_000;
const GITMODULES = '[submodule "RobustToolbox"]\n\tpath = RobustToolbox\n\turl = https://example/RobustToolbox.git\n';

/** A fully healthy, freshly-built fork; individual tests knock one thing out. */
function healthySpec(overrides: FakeForkSpec = {}): FakeForkSpec {
  return {
    gitmodules: GITMODULES,
    dirs: [
      'Content.Server',
      'Content.Client',
      'Resources/Prototypes',
      'bin/Content.Server',
      'bin/Content.Client',
    ],
    files: {
      'bin/Content.Server/Content.Server.dll': T0 + 1000,
      'bin/Content.Server/Content.Shared.dll': T0 + 900,
      'bin/Content.Client/Content.Client.dll': T0 + 1000,
      'Content.Server/Foo.cs': T0,
      'Content.Client/Bar.cs': T0,
    },
    tracked: {
      'Content.Server': ['Content.Server/Foo.cs'],
      'Content.Client': ['Content.Client/Bar.cs'],
    },
    ...overrides,
  };
}

describe('detectFork', () => {
  it('recognises a healthy, freshly-built fork', () => {
    expect(detectFork(fakeForkFs(healthySpec()))).toEqual({ recognized: true });
  });

  describe('missing mandatory signals', () => {
    it('names the missing RobustToolbox submodule when .gitmodules is absent', () => {
      const status = detectFork(fakeForkFs(healthySpec({ gitmodules: null })));
      expect(status).toMatchObject({ recognized: false, code: 'no-robusttoolbox-submodule' });
    });

    it('names the missing RobustToolbox submodule when .gitmodules lists only other submodules', () => {
      const gitmodules = '[submodule "OtherLib"]\n\tpath = OtherLib\n';
      const status = detectFork(fakeForkFs(healthySpec({ gitmodules })));
      expect(status).toMatchObject({ recognized: false, code: 'no-robusttoolbox-submodule' });
    });

    it('matches the RobustToolbox path line regardless of surrounding whitespace', () => {
      const gitmodules = '[submodule "rtb"]\n    path=RobustToolbox   \n';
      expect(detectFork(fakeForkFs(healthySpec({ gitmodules })))).toEqual({ recognized: true });
    });

    it('rejects a RobustToolbox-named stanza whose path points elsewhere', () => {
      const gitmodules = '[submodule "RobustToolbox"]\n\tpath = Engine\n';
      expect(detectFork(fakeForkFs(healthySpec({ gitmodules })))).toMatchObject({
        recognized: false,
        code: 'no-robusttoolbox-submodule',
      });
    });

    it('names the missing Content.Server directory', () => {
      const spec = healthySpec();
      spec.dirs = spec.dirs!.filter((d) => d !== 'Content.Server');
      expect(detectFork(fakeForkFs(spec))).toMatchObject({
        recognized: false,
        code: 'no-content-server',
      });
    });

    it('names the missing Content.Client directory', () => {
      const spec = healthySpec();
      spec.dirs = spec.dirs!.filter((d) => d !== 'Content.Client');
      expect(detectFork(fakeForkFs(spec))).toMatchObject({
        recognized: false,
        code: 'no-content-client',
      });
    });

    it('names the missing Resources/Prototypes directory', () => {
      const spec = healthySpec();
      spec.dirs = spec.dirs!.filter((d) => d !== 'Resources/Prototypes');
      expect(detectFork(fakeForkFs(spec))).toMatchObject({
        recognized: false,
        code: 'no-resources-prototypes',
      });
    });

    it('reports the most fundamental signal first when several are missing', () => {
      const spec = healthySpec({ gitmodules: null });
      spec.dirs = [];
      expect(detectFork(fakeForkFs(spec))).toMatchObject({ code: 'no-robusttoolbox-submodule' });
    });
  });

  describe('build output', () => {
    it('reports "DLLs not found" when bin/Content.Server has no DLLs', () => {
      const spec = healthySpec();
      delete spec.files!['bin/Content.Server/Content.Server.dll'];
      delete spec.files!['bin/Content.Server/Content.Shared.dll'];
      expect(detectFork(fakeForkFs(spec))).toMatchObject({
        recognized: false,
        code: 'dlls-not-found',
      });
    });

    it('reports "DLLs not found" when bin/Content.Client has no DLLs', () => {
      const spec = healthySpec();
      delete spec.files!['bin/Content.Client/Content.Client.dll'];
      expect(detectFork(fakeForkFs(spec))).toMatchObject({
        recognized: false,
        code: 'dlls-not-found',
      });
    });

    it('ignores DLLs under Content.*/bin and obj (only bin/Content.* counts)', () => {
      const spec = healthySpec();
      delete spec.files!['bin/Content.Server/Content.Server.dll'];
      delete spec.files!['bin/Content.Server/Content.Shared.dll'];
      spec.files!['Content.Server/bin/Content.Server.dll'] = T0 + 1000;
      spec.files!['obj/Content.Server.dll'] = T0 + 1000;
      expect(detectFork(fakeForkFs(spec))).toMatchObject({ code: 'dlls-not-found' });
    });
  });

  describe('build freshness', () => {
    // A stale build still has DLLs the schema can be read from — the last good
    // build — so it is recognised, with a warning, rather than blocked.
    it('recognises a stale Content.Server build, with a warning', () => {
      const spec = healthySpec();
      spec.files!['Content.Server/Foo.cs'] = T0 + 5000;
      expect(detectFork(fakeForkFs(spec))).toMatchObject({
        recognized: true,
        stale: { projects: ['Content.Server'] },
      });
    });

    it('recognises a stale Content.Client build, with a warning', () => {
      const spec = healthySpec();
      spec.files!['Content.Client/Bar.cs'] = T0 + 5000;
      expect(detectFork(fakeForkFs(spec))).toMatchObject({
        recognized: true,
        stale: { projects: ['Content.Client'] },
      });
    });

    it('lists both projects when both are stale', () => {
      const spec = healthySpec();
      spec.files!['Content.Server/Foo.cs'] = T0 + 5000;
      spec.files!['Content.Client/Bar.cs'] = T0 + 5000;
      const status = detectFork(fakeForkFs(spec));
      expect(status).toMatchObject({
        recognized: true,
        stale: { projects: ['Content.Server', 'Content.Client'] },
      });
      const message = (status as { stale: { message: string } }).stale.message;
      expect(message).toContain('Content.Server, Content.Client');
      expect(message).toContain('last build');
    });

    it('treats an equal mtime as fresh (not older, per spec)', () => {
      const spec = healthySpec();
      spec.files!['Content.Server/Foo.cs'] = T0 + 1000; // == newest Server DLL
      expect(detectFork(fakeForkFs(spec))).toEqual({ recognized: true });
    });

    it('does not flag staleness from a generated .cs that git does not track', () => {
      const spec = healthySpec();
      // AssemblyInfo.cs is newer than every DLL but is not in `git ls-files`.
      spec.files!['Content.Server/obj/Debug/net8.0/Content.Server.AssemblyInfo.cs'] = T0 + 999_999;
      expect(detectFork(fakeForkFs(spec))).toEqual({ recognized: true });
    });

    it('does not flag staleness when git is unavailable', () => {
      const spec = healthySpec({ tracked: null });
      spec.files!['Content.Server/Foo.cs'] = T0 + 999_999;
      expect(detectFork(fakeForkFs(spec))).toEqual({ recognized: true });
    });

    it('does not flag staleness when no .cs is tracked', () => {
      const spec = healthySpec({ tracked: { 'Content.Server': [], 'Content.Client': [] } });
      spec.files!['Content.Server/Foo.cs'] = T0 + 999_999;
      expect(detectFork(fakeForkFs(spec))).toEqual({ recognized: true });
    });
  });

  it('gives every failure state a non-empty, panel-ready message', () => {
    const specs: FakeForkSpec[] = [
      healthySpec({ gitmodules: null }),
      (() => {
        const s = healthySpec();
        s.dirs = s.dirs!.filter((d) => d !== 'Content.Server');
        return s;
      })(),
      (() => {
        const s = healthySpec();
        delete s.files!['bin/Content.Server/Content.Server.dll'];
        delete s.files!['bin/Content.Server/Content.Shared.dll'];
        return s;
      })(),
    ];
    for (const spec of specs) {
      const status = detectFork(fakeForkFs(spec));
      expect(status.recognized).toBe(false);
      expect((status as { message: string }).message.length).toBeGreaterThan(0);
    }
  });
});
