import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import {
  collectRecords,
  diffRecords,
  indexBuilding,
  indexFailed,
  indexFingerprint,
  indexReady,
  parseIndexCache,
  prototypeRootOf,
  PrototypeIndex,
  serializeIndexCache,
  type PrototypeRecord,
} from '../../src/core/prototype-index';
import { fixtureText } from './prototype-fixtures';

// ---------------------------------------------------------------------------
// fixtures.json from `prototype/prototype-index-benchmark`: real crystall-edge
// prototypes (multiple inheritance, a 10-deep chain, abstract bases, a Tag).
// ---------------------------------------------------------------------------

interface FixtureProto {
  readonly own: Record<string, unknown> & { type: string; id: string; parent?: string | string[] };
}

function benchmarkFixtures(): FixtureProto[] {
  const raw = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/prototype-index/fixtures.json', import.meta.url)),
      'utf8',
    ),
  );
  return [
    raw.multiParentExample,
    ...raw.multiParentExample.parents,
    ...raw.deepChain,
    raw.abstractExample,
    raw.smallKindExample,
  ];
}

function expectedParents(parent: string | string[] | undefined): string[] {
  if (parent === undefined) return [];
  return Array.isArray(parent) ? parent : [parent];
}

function collectOk(text: string, filePath = 'Resources/Prototypes/a.yml', engine = false) {
  const result = collectRecords(text, filePath, engine);
  if (!result.ok) throw new Error(`expected ok, got ${result.errors.join('; ')}`);
  return result.records;
}

function record(overrides: Partial<PrototypeRecord> & Pick<PrototypeRecord, 'kind' | 'id'>): PrototypeRecord {
  return {
    filePath: 'Resources/Prototypes/a.yml',
    range: [0, 10, 11],
    parents: [],
    abstract: false,
    engine: false,
    ...overrides,
  };
}

describe('collectRecords on fixtures.json', () => {
  const protos = benchmarkFixtures();
  const text = stringify(protos.map((p) => p.own));
  const records = collectOk(text);

  it('yields one record per prototype, in source order', () => {
    expect(records.map((r) => `${r.kind}:${r.id}`)).toEqual(
      protos.map((p) => `${p.own.type}:${p.own.id}`),
    );
  });

  it('keeps parents in declaration order, scalar or list', () => {
    for (const [i, proto] of protos.entries()) {
      expect(records[i].parents).toEqual(expectedParents(proto.own.parent));
    }
    const multi = records.find((r) => r.id === 'ActionActivateMicroBomb');
    expect(multi?.parents).toEqual(['BaseSuicideAction', 'BaseImplantAction']);
  });

  it('reads abstract: true, defaulting to false', () => {
    for (const [i, proto] of protos.entries()) {
      expect(records[i].abstract).toBe(proto.own.abstract === true);
    }
    expect(records.some((r) => r.abstract)).toBe(true);
    expect(records.some((r) => !r.abstract)).toBe(true);
  });

  it('carries filePath and the engine flag through', () => {
    const engine = collectOk(text, 'RobustToolbox/Resources/EnginePrototypes/x.yml', true);
    expect(engine.every((r) => r.engine && r.filePath === 'RobustToolbox/Resources/EnginePrototypes/x.yml')).toBe(true);
    expect(records.every((r) => !r.engine)).toBe(true);
  });

  it('gives each record the [start, valueEnd, nodeEnd] range of its prototype map', () => {
    for (const r of records) {
      const [start, valueEnd, nodeEnd] = r.range;
      expect(start).toBeLessThan(valueEnd);
      expect(valueEnd).toBeLessThanOrEqual(nodeEnd);
      const slice = text.slice(start, valueEnd);
      expect(slice.startsWith('type: ')).toBe(true);
      expect(slice).toContain(`id: ${r.id}`);
    }
  });

  it('keys are exact strings: no case normalisation', () => {
    const recs = collectOk('- type: Tag\n  id: Foo\n- type: tag\n  id: foo\n');
    expect(recs.map((r) => [r.kind, r.id])).toEqual([
      ['Tag', 'Foo'],
      ['tag', 'foo'],
    ]);
  });
});

describe('collectRecords on real files', () => {
  it('a BOM file yields exactly the records of the same file without BOM', () => {
    const bom = fixtureText('bom.yml');
    expect(bom.charCodeAt(0)).toBe(0xfeff);
    const withBom = collectOk(bom);
    expect(withBom.length).toBeGreaterThan(0);
    expect(withBom).toEqual(collectOk(fixtureText('light.yml')));
  });

  it('a broken file is reported, not partially indexed', () => {
    const result = collectRecords('- type: entity\n  id: Ok\n- type: [unclosed\n', 'broken.yml', false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it('skips items without type or id (CreateVariants templates) and non-map items', () => {
    const recs = collectOk('- type: entity\n  name: no id\n- id: NoType\n- just a string\n- type: entity\n  id: Kept\n');
    expect(recs.map((r) => r.id)).toEqual(['Kept']);
  });

  it('tolerates empty files, empty documents and non-sequence roots', () => {
    expect(collectOk('')).toEqual([]);
    expect(collectOk('# only a comment\n')).toEqual([]);
    expect(collectOk('key: value\n')).toEqual([]);
  });

  it('indexes every document of a multi-document stream', () => {
    const recs = collectOk('- type: Tag\n  id: A\n---\n- type: Tag\n  id: B\n');
    expect(recs.map((r) => r.id)).toEqual(['A', 'B']);
  });

  it('resolves an aliased id or parent to its anchored value (real tabletop prototypes do this)', () => {
    const recs = collectOk(
      [
        '- type: entity',
        '  id: BackgammonBoard',
        '  components:',
        '  - type: TabletopGame',
        '    setup:',
        '      !type:TabletopBackgammonSetup',
        '      boardPrototype: &BackgammonBoard BackgammonBoardTabletop',
        '- type: entity',
        '  id: *BackgammonBoard',
        "  parent: [ *BackgammonBoard, '' ]",
        '',
      ].join('\n'),
    );
    expect(recs.map((r) => r.id)).toEqual(['BackgammonBoard', 'BackgammonBoardTabletop']);
    expect(recs[1].parents).toEqual(['BackgammonBoardTabletop']);
  });

  it('resolves an aliased abstract flag', () => {
    const recs = collectOk('- type: Tag\n  id: A\n  abstract: &yes true\n- type: Tag\n  id: B\n  abstract: *yes\n');
    expect(recs.map((r) => r.abstract)).toEqual([true, true]);
  });

  it('treats an empty parent as no parents', () => {
    expect(collectOk('- type: entity\n  id: A\n  parent:\n')[0].parents).toEqual([]);
  });
});

describe('diffRecords', () => {
  const a = record({ kind: 'entity', id: 'A' });
  const b = record({ kind: 'entity', id: 'B', range: [20, 30, 31] });

  it('reports nothing for identical sets', () => {
    expect(diffRecords([a, b], [{ ...a }, { ...b }])).toEqual({ added: [], removed: [], changed: [] });
  });

  it('reports an added prototype', () => {
    expect(diffRecords([a], [a, b])).toEqual({ added: [b], removed: [], changed: [] });
  });

  it('reports a removed prototype', () => {
    expect(diffRecords([a, b], [a])).toEqual({ added: [], removed: [b], changed: [] });
  });

  it('reports a range change', () => {
    const moved = { ...b, range: [40, 50, 51] as const };
    expect(diffRecords([a, b], [a, moved])).toEqual({
      added: [],
      removed: [],
      changed: [{ before: b, after: moved }],
    });
  });

  it('reports a parents change, order-sensitive', () => {
    const before = record({ kind: 'entity', id: 'C', parents: ['X', 'Y'] });
    const after = { ...before, parents: ['Y', 'X'] };
    expect(diffRecords([before], [after]).changed).toEqual([{ before, after }]);
  });

  it('reports abstract and filePath changes', () => {
    const abs = { ...a, abstract: true };
    const moved = { ...a, filePath: 'other.yml' };
    expect(diffRecords([a], [abs]).changed).toHaveLength(1);
    expect(diffRecords([a], [moved]).changed).toHaveLength(1);
  });

  it('keys on the exact (kind, id) pair', () => {
    const otherKind = record({ kind: 'Tag', id: 'A' });
    expect(diffRecords([a], [otherKind])).toEqual({ added: [otherKind], removed: [a], changed: [] });
  });
});

describe('PrototypeIndex', () => {
  const fileA = 'Resources/Prototypes/a.yml';
  const fileB = 'Resources/Prototypes/b.yml';
  const a1 = record({ kind: 'entity', id: 'A1', filePath: fileA });
  const a2 = record({ kind: 'entity', id: 'A2', filePath: fileA, range: [20, 30, 31] });
  const b1 = record({ kind: 'Tag', id: 'B1', filePath: fileB });

  it('answers "not ready" before the first load, not "absent"', () => {
    const index = new PrototypeIndex();
    expect(index.ready).toBe(false);
    expect(index.get('entity', 'A1')).toEqual({ ready: false });
  });

  it('looks up by exact (kind, id) once loaded', () => {
    const index = new PrototypeIndex();
    index.replaceAll([a1, a2, b1]);
    expect(index.ready).toBe(true);
    expect(index.size).toBe(3);
    expect(index.get('entity', 'A1')).toEqual({ ready: true, record: a1 });
    expect(index.get('Entity', 'A1')).toEqual({ ready: true, record: undefined });
    expect(index.get('Tag', 'B1')).toEqual({ ready: true, record: b1 });
  });

  it('updateFile adds a new prototype and returns the diff for that file only', () => {
    const index = new PrototypeIndex();
    index.replaceAll([a1, b1]);
    const diff = index.updateFile(fileA, [a1, a2]);
    expect(diff).toEqual({ added: [a2], removed: [], changed: [] });
    expect(index.size).toBe(3);
    expect(index.get('entity', 'A2')).toEqual({ ready: true, record: a2 });
  });

  it('updateFile drops a prototype removed from the file', () => {
    const index = new PrototypeIndex();
    index.replaceAll([a1, a2, b1]);
    expect(index.updateFile(fileA, [a2])).toEqual({ added: [], removed: [a1], changed: [] });
    expect(index.get('entity', 'A1')).toEqual({ ready: true, record: undefined });
    expect(index.size).toBe(2);
  });

  it('updateFile with no records forgets the file entirely (deleted file)', () => {
    const index = new PrototypeIndex();
    index.replaceAll([a1, a2, b1]);
    expect(index.updateFile(fileA, []).removed).toEqual([a1, a2]);
    expect(index.files()).toEqual([fileB]);
  });

  it('a duplicate (kind, id) in another file survives removal of its twin', () => {
    const dup = { ...a1, filePath: fileB };
    const index = new PrototypeIndex();
    index.replaceAll([a1, b1, dup]);
    index.updateFile(fileA, []);
    expect(index.get('entity', 'A1')).toEqual({ ready: true, record: dup });
  });

  it('all() returns every record', () => {
    const index = new PrototypeIndex();
    index.replaceAll([a1, a2, b1]);
    expect([...index.all()]).toEqual(expect.arrayContaining([a1, a2, b1]));
  });
});

describe('index cache', () => {
  const files = [
    { path: 'Resources/Prototypes/a.yml', mtimeMs: 1000 },
    { path: 'Resources/Prototypes/b.yml', mtimeMs: 2000 },
  ];

  it('the fingerprint is order-independent and stable', () => {
    expect(indexFingerprint(files, 1)).toBe(indexFingerprint([...files].reverse(), 1));
  });

  it('the fingerprint moves on an mtime change, an added/removed file, or a schemaVersion bump', () => {
    const base = indexFingerprint(files, 1);
    expect(indexFingerprint([files[0], { ...files[1], mtimeMs: 2001 }], 1)).not.toBe(base);
    expect(indexFingerprint([files[0]], 1)).not.toBe(base);
    expect(indexFingerprint([...files, { path: 'c.yml', mtimeMs: 1 }], 1)).not.toBe(base);
    expect(indexFingerprint(files, 2)).not.toBe(base);
  });

  it('round-trips raw records and the skipped-file list', () => {
    const records = [
      record({ kind: 'entity', id: 'A', parents: ['P', 'Q'], abstract: true }),
      record({ kind: 'Tag', id: 'T', engine: true, filePath: 'RobustToolbox/x.yml' }),
    ];
    expect(parseIndexCache(serializeIndexCache('fp', records, ['broken.yml']))).toEqual({
      fingerprint: 'fp',
      records,
      skippedFiles: ['broken.yml'],
    });
  });

  it('rejects garbage or a foreign cache format', () => {
    expect(parseIndexCache('not json')).toBeUndefined();
    expect(parseIndexCache('{}')).toBeUndefined();
    expect(parseIndexCache(JSON.stringify({ format: -1, fingerprint: 'x', records: [] }))).toBeUndefined();
  });
});

describe('index status', () => {
  it('carries a user-facing message for progress, the final count, and failures', () => {
    expect(indexBuilding(10, 100).message).toBe('Indexing prototypes… 10/100 files');
    expect(indexReady(25200, 0).message).toBe('Prototype index: 25200 prototypes.');
    expect(indexReady(3, 2).message).toBe('Prototype index: 3 prototypes (2 unparseable files skipped).');
    expect(indexFailed('boom').message).toBe('Prototype index failed: boom');
  });
});

describe('prototypeRootOf', () => {
  it('maps content and engine paths to their root, and nothing else', () => {
    expect(prototypeRootOf('Resources/Prototypes/a/b.yml')?.engine).toBe(false);
    expect(prototypeRootOf('Resources/Prototypes')?.engine).toBe(false);
    expect(prototypeRootOf('RobustToolbox/Resources/EnginePrototypes/x.yml')?.engine).toBe(true);
    expect(prototypeRootOf('Resources/PrototypesOld/x.yml')).toBeUndefined();
    expect(prototypeRootOf('Resources/Maps/x.yml')).toBeUndefined();
  });
});
