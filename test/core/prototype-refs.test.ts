import { describe, expect, it } from 'vitest';

import { completionsAt } from '../../src/core/completion';
import { definitionAt } from '../../src/core/definition';
import { collectRecords, PrototypeIndex, type PrototypeRecord } from '../../src/core/prototype-index';
import { schemaSnapshot } from './prototype-fixtures';

/**
 * Prototype-id autocomplete and go-to-definition (issue #33). The schema is the
 * committed crystall-edge snapshot; the index is built from the small fork below
 * with the real `collectRecords`, so the targets asserted here are exactly what
 * the live index would hold.
 */
const SCHEMA = schemaSnapshot();

const ENTITIES_PATH = 'Resources/Prototypes/Entities/base.yml';
const ENTITIES = [
  '- type: entity',
  '  id: BaseItem',
  '  abstract: true',
  '',
  '- type: entity',
  '  id: BaseWeapon',
  '  parent: BaseItem',
  '',
  '- type: entity',
  '  id: FireAxe',
  '',
].join('\n');

const REAGENTS_PATH = 'Resources/Prototypes/Reagents/fuel.yml';
const REAGENTS = ['- type: reagent', '  id: WeldingFuel', '', '- type: reagent', '  id: SpaceLube', ''].join('\n');

const ENGINE_PATH = 'RobustToolbox/Resources/EnginePrototypes/base.yml';
const ENGINE = ['- type: entity', '  id: EngineBase', '  abstract: true', ''].join('\n');

function records(text: string, filePath: string, engine: boolean): readonly PrototypeRecord[] {
  const result = collectRecords(text, filePath, engine);
  if (!result.ok) throw new Error(`fixture ${filePath} did not parse`);
  return result.records;
}

function readyIndex(): PrototypeIndex {
  const index = new PrototypeIndex();
  index.replaceAll([
    ...records(ENTITIES, ENTITIES_PATH, false),
    ...records(REAGENTS, REAGENTS_PATH, false),
    ...records(ENGINE, ENGINE_PATH, true),
  ]);
  return index;
}

const INDEX = readyIndex();

/** `lines` joined with `\n`, caret at the end of the last one. */
function atEnd(lines: readonly string[]): { text: string; offset: number } {
  const joined = lines.join('\n');
  return { text: joined + '\n', offset: joined.length };
}

/** Text and caret placed right after `marker`'s first occurrence. */
function after(lines: readonly string[], marker: string): { text: string; offset: number } {
  const text = lines.join('\n') + '\n';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`marker ${marker} not in text`);
  return { text, offset: at + marker.length };
}

function labels(text: string, offset: number, index = INDEX): string[] {
  return completionsAt(text, offset, SCHEMA, index).map((c) => c.label).sort();
}

const ALL_ENTITIES = ['BaseItem', 'BaseWeapon', 'EngineBase', 'FireAxe'];
const ALL_REAGENTS = ['SpaceLube', 'WeldingFuel'];

describe('completionsAt — prototype ids, filtered by the field\'s target kind', () => {
  it('offers only entities in `parent:`, abstract ones included', () => {
    const { text, offset } = atEnd(['- type: entity', '  id: X', '  parent: ']);
    expect(labels(text, offset)).toEqual(ALL_ENTITIES);
  });

  it('offers only reagents in a `ProtoId<ReagentPrototype>` field', () => {
    const { text, offset } = atEnd([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: Welder',
      '    fuelReagent: Wel',
    ]);
    expect(labels(text, offset)).toEqual(ALL_REAGENTS);
  });

  it('offers entities in an `EntProtoId` field', () => {
    const { text, offset } = atEnd([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: SpawnAfterInteract',
      '    prototype: ',
    ]);
    expect(labels(text, offset)).toEqual(ALL_ENTITIES);
  });

  it('marks ids with their kind and abstract ones as abstract', () => {
    const { text, offset } = atEnd(['- type: entity', '  id: X', '  parent: ']);
    const candidates = completionsAt(text, offset, SCHEMA, INDEX);
    expect(candidates.find((c) => c.label === 'BaseItem')).toEqual({
      label: 'BaseItem',
      kind: 'id',
      detail: 'entity (abstract)',
    });
    expect(candidates.find((c) => c.label === 'FireAxe')).toEqual({ label: 'FireAxe', kind: 'id', detail: 'entity' });
  });

  it('re-supplies the space when the caret sits right against the colon', () => {
    const { text, offset } = atEnd(['- type: entity', '  id: X', '  parent:']);
    const candidates = completionsAt(text, offset, SCHEMA, INDEX);
    expect(candidates.find((c) => c.label === 'FireAxe')?.insertText).toBe(' FireAxe');
  });

  it('lists a duplicated id once', () => {
    const index = new PrototypeIndex();
    index.replaceAll([
      ...records(REAGENTS, REAGENTS_PATH, false),
      ...records(REAGENTS, 'Resources/Prototypes/Reagents/copy.yml', false),
    ]);
    const { text, offset } = atEnd([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: Lube',
      '    reagent: ',
    ]);
    expect(labels(text, offset, index)).toEqual(ALL_REAGENTS);
  });

  describe('`parent:` as a list', () => {
    it('offers entities on a written list item', () => {
      const { text, offset } = after(
        ['- type: entity', '  id: X', '  parent:', '  - BaseItem', '  - FireAxe'],
        '  - Fire',
      );
      expect(labels(text, offset)).toEqual(ALL_ENTITIES);
    });

    it('offers entities on a bare `- ` item', () => {
      const { text, offset } = atEnd(['- type: entity', '  id: X', '  parent:', '  - BaseItem', '  - ']);
      expect(labels(text, offset)).toEqual(ALL_ENTITIES);
    });

    it('offers entities inside a flow list', () => {
      const { text, offset } = after(['- type: entity', '  id: X', '  parent: [BaseItem, Fire]'], ', Fi');
      expect(labels(text, offset)).toEqual(ALL_ENTITIES);
    });
  });

  it('offers entities on a bare `- ` item of a list of `EntProtoId`s', () => {
    const { text, offset } = atEnd([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: Rehydratable',
      '    possibleSpawns:',
      '    - FireAxe',
      '    - ',
    ]);
    expect(labels(text, offset)).toEqual(ALL_ENTITIES);
  });

  it('still offers component names on a bare `- ` in `components:`', () => {
    const { text, offset } = atEnd(['- type: entity', '  id: X', '  components:', '  - ']);
    const candidates = completionsAt(text, offset, SCHEMA, INDEX);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.kind === 'component')).toBe(true);
  });

  it('returns [] before the index is ready', () => {
    const { text, offset } = atEnd(['- type: entity', '  id: X', '  parent: ']);
    expect(completionsAt(text, offset, SCHEMA, new PrototypeIndex())).toEqual([]);
  });

  it('returns [] without an index', () => {
    const { text, offset } = atEnd(['- type: entity', '  id: X', '  parent: ']);
    expect(completionsAt(text, offset, SCHEMA)).toEqual([]);
  });
});

/**
 * A dictionary's keys are data, not field names: `events: { 0: [...] }` keys a
 * `Dictionary<TimeSpan, List<CEEntityEffect>>` by time. The chain walk must step
 * over such a key into the dictionary's value type, so an id nested below it is
 * found the same way as one on the prototype map.
 */
describe('prototype ids below a dictionary key', () => {
  const animation = [
    '- type: entityEffectAnimation',
    '  id: X',
    '  events:',
    '    0:',
    '    - !type:SpawnEntity',
    '      effectTarget: User',
    '      spawns:',
    '      - FireAxe',
  ];

  it('targets an `EntProtoId` list item inside a tagged effect', () => {
    const { text, offset } = after(animation, '      - Fire');
    expect(definitionAt(text, offset, SCHEMA, INDEX)?.target.id).toBe('FireAxe');
  });

  it('offers entities on a bare `- ` item there', () => {
    const { text, offset } = atEnd([...animation, '      - ']);
    expect(labels(text, offset)).toEqual(ALL_ENTITIES);
  });
});

describe('definitionAt — the declaration of the id under the caret', () => {
  const entityRecord = (id: string) => INDEX.get('entity', id);

  it('targets the parent\'s record: its file and range', () => {
    const { text, offset } = after(['- type: entity', '  id: X', '  parent: BaseWeapon'], 'parent: Base');

    const definition = definitionAt(text, offset, SCHEMA, INDEX);
    const lookup = entityRecord('BaseWeapon');
    if (!lookup.ready || !lookup.record) throw new Error('BaseWeapon not indexed');

    expect(definition?.target).toEqual(lookup.record);
    expect(definition?.target.filePath).toBe(ENTITIES_PATH);
    // The range opens on the prototype's own line in its file.
    expect(ENTITIES.slice(definition!.target.range[0]).startsWith('type: entity\n  id: BaseWeapon')).toBe(true);
    // The origin covers the whole id, not just the part before the caret.
    expect(text.slice(...definition!.origin)).toBe('BaseWeapon');
  });

  it('targets an engine prototype in `RobustToolbox/Resources/EnginePrototypes/`', () => {
    const { text, offset } = after(['- type: entity', '  id: X', '  parent: EngineBase'], 'parent: Eng');
    const definition = definitionAt(text, offset, SCHEMA, INDEX);
    expect(definition?.target.filePath).toBe(ENGINE_PATH);
    expect(definition?.target.engine).toBe(true);
  });

  it('works on each item of a `parent:` list the same way', () => {
    const lines = ['- type: entity', '  id: X', '  parent:', '  - BaseItem', '  - FireAxe'];
    const first = after(lines, '  - Base');
    const second = after(lines, '  - Fire');
    expect(definitionAt(first.text, first.offset, SCHEMA, INDEX)?.target.id).toBe('BaseItem');
    expect(definitionAt(second.text, second.offset, SCHEMA, INDEX)?.target.id).toBe('FireAxe');
  });

  it('works inside a flow list', () => {
    const { text, offset } = after(['- type: entity', '  id: X', '  parent: [BaseItem, FireAxe]'], ', Fi');
    const definition = definitionAt(text, offset, SCHEMA, INDEX);
    expect(definition?.target.id).toBe('FireAxe');
    expect(text.slice(...definition!.origin)).toBe('FireAxe');
  });

  it('looks the id up under the field\'s kind, not under every kind', () => {
    const lines = ['- type: entity', '  id: X', '  components:', '  - type: Lube', '    reagent: SpaceLube'];
    const { text, offset } = after(lines, 'reagent: Space');
    expect(definitionAt(text, offset, SCHEMA, INDEX)?.target).toMatchObject({
      kind: 'reagent',
      id: 'SpaceLube',
      filePath: REAGENTS_PATH,
    });

    // An entity id in a reagent field is not a reagent — no target.
    const wrong = after(
      ['- type: entity', '  id: X', '  components:', '  - type: Lube', '    reagent: FireAxe'],
      'reagent: Fire',
    );
    expect(definitionAt(wrong.text, wrong.offset, SCHEMA, INDEX)).toBeNull();
  });

  it('returns null for an id the index does not hold', () => {
    const { text, offset } = after(['- type: entity', '  id: X', '  parent: Nowhere'], 'parent: Now');
    expect(definitionAt(text, offset, SCHEMA, INDEX)).toBeNull();
  });

  it('returns null off a prototype-id field', () => {
    const { text, offset } = after(['- type: entity', '  id: X', '  name: FireAxe'], 'name: Fire');
    expect(definitionAt(text, offset, SCHEMA, INDEX)).toBeNull();
  });

  it('returns null before the index is ready', () => {
    const { text, offset } = after(['- type: entity', '  id: X', '  parent: BaseItem'], 'parent: Base');
    expect(definitionAt(text, offset, SCHEMA, new PrototypeIndex())).toBeNull();
  });
});
