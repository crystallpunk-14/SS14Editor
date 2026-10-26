import { describe, expect, it } from 'vitest';

import type { ForkFolderStatus } from '../../src/core/fork-detection';
import { indexBuilding, indexFailed, indexReady } from '../../src/core/prototype-index';
import type { SchemaStatus } from '../../src/core/schema';
import { forkStatusLog, indexStatusLog, schemaStatusLog } from '../../src/core/status-log';

const recognized: ForkFolderStatus = { name: 'crystall-edge', status: { recognized: true } };

const unbuilt: ForkFolderStatus = {
  name: 'crystall-edge',
  status: {
    recognized: false,
    code: 'dlls-not-found',
    message: 'SS14 fork found, but it is not built: bin/Content.Server/*.dll is missing.',
  },
};

const stale: ForkFolderStatus = {
  name: 'crystall-edge',
  status: {
    recognized: true,
    stale: { projects: ['Content.Server'], message: 'The build is older than the C# sources.' },
  },
};

const loaded: SchemaStatus = {
  state: 'loaded',
  message: 'Schema loaded from the fork build: 812 components.',
  componentCount: 812,
  schemaVersion: 1,
  sourceFingerprint: 'abc',
};

const dotnetMissing: SchemaStatus = {
  state: 'dotnet-missing',
  message: '`dotnet` was not found on PATH.',
};

describe('forkStatusLog', () => {
  it('logs the concrete reason an unrecognised folder is not a fork', () => {
    expect(forkStatusLog(undefined, unbuilt)).toEqual([
      '[fork] crystall-edge: SS14 fork found, but it is not built: bin/Content.Server/*.dll is missing.',
    ]);
  });

  it('logs a recognised fork, and the stale-build warning beside it', () => {
    expect(forkStatusLog(undefined, recognized)).toEqual(['[fork] crystall-edge: SS14 fork recognized.']);
    expect(forkStatusLog(undefined, stale)).toEqual([
      '[fork] crystall-edge: SS14 fork recognized.',
      '[fork] crystall-edge: The build is older than the C# sources.',
    ]);
  });

  it('tells the user to open a fork folder when no local folder is open', () => {
    expect(forkStatusLog(undefined, null)).toEqual([
      '[fork] No local folder is open. Open an SS14 fork folder to get started.',
    ]);
  });

  it('stays silent when a re-detection returns the same verdict', () => {
    expect(forkStatusLog(recognized, { ...recognized, status: { recognized: true } })).toEqual([]);
    expect(forkStatusLog(null, null)).toEqual([]);
  });

  it('logs again once the verdict changes', () => {
    expect(forkStatusLog(stale, recognized)).toEqual(['[fork] crystall-edge: SS14 fork recognized.']);
    expect(forkStatusLog(recognized, unbuilt)).toHaveLength(1);
  });
});

describe('schemaStatusLog', () => {
  it('logs the schema verdict verbatim', () => {
    expect(schemaStatusLog(undefined, loaded)).toEqual([
      '[schema] Schema loaded from the fork build: 812 components.',
    ]);
    expect(schemaStatusLog(loaded, dotnetMissing)).toEqual(['[schema] `dotnet` was not found on PATH.']);
  });

  it('adds the extractor stderr under a failed extraction', () => {
    const failed: SchemaStatus = {
      state: 'extraction-failed',
      message: 'The schema extractor failed (exit code 1).',
      stderr: 'Unhandled exception.\n   at Program.Main()',
    };
    expect(schemaStatusLog(undefined, failed)).toEqual([
      '[schema] The schema extractor failed (exit code 1).',
      '[schema]   Unhandled exception.',
      '[schema]      at Program.Main()',
    ]);
  });

  it('stays silent when there is no schema to speak of, or nothing changed', () => {
    // `null` = not a recognised fork; the fork line already explains why.
    expect(schemaStatusLog(loaded, null)).toEqual([]);
    expect(schemaStatusLog(loaded, { ...loaded })).toEqual([]);
  });

  it('logs a re-run that lands on the same verdict after the schema was cleared', () => {
    expect(schemaStatusLog(null, loaded)).toHaveLength(1);
  });
});

describe('indexStatusLog', () => {
  it('logs the start of a build once, not every progress tick', () => {
    expect(indexStatusLog(undefined, indexBuilding(0, 0))).toEqual(['[index] Indexing prototypes…']);
    expect(indexStatusLog(indexBuilding(0, 0), indexBuilding(40, 2767))).toEqual([]);
    expect(indexStatusLog(indexBuilding(40, 2767), indexBuilding(80, 2767))).toEqual([]);
  });

  it('logs the result of a build', () => {
    expect(indexStatusLog(indexBuilding(2767, 2767), indexReady(25200, 0))).toEqual([
      '[index] Prototype index: 25200 prototypes.',
    ]);
    expect(indexStatusLog(indexBuilding(10, 2767), indexFailed('out of memory'))).toEqual([
      '[index] Prototype index failed: out of memory',
    ]);
  });

  it('logs an incremental update only when the count moves', () => {
    expect(indexStatusLog(indexReady(25200, 0), indexReady(25200, 0))).toEqual([]);
    expect(indexStatusLog(indexReady(25200, 0), indexReady(25201, 0))).toEqual([
      '[index] Prototype index: 25201 prototypes.',
    ]);
  });

  it('stays silent when the index is torn down', () => {
    expect(indexStatusLog(indexReady(25200, 0), null)).toEqual([]);
  });
});
