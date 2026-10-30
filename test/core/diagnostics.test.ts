import { describe, expect, it } from 'vitest';

import { diagnosticsFor, type PrototypeDiagnostic } from '../../src/core/diagnostics';
import { collectRecords, PrototypeIndex, type PrototypeRecord } from '../../src/core/prototype-index';
import { schemaSnapshot } from './prototype-fixtures';

/**
 * Whole-file diagnostics (Rider plan, stage 4). The schema is the committed
 * crystall-edge snapshot; the index is built from the small fork below with the
 * real `collectRecords`, as in the prototype-reference tests.
 */
const SCHEMA = schemaSnapshot();

const FORK: ReadonlyArray<[path: string, text: string, engine: boolean]> = [
  [
    'Resources/Prototypes/Entities/base.yml',
    ['- type: entity', '  id: BaseItem', '  abstract: true', '', '- type: entity', '  id: FireAxe', ''].join('\n'),
    false,
  ],
  ['Resources/Prototypes/Damage/types.yml', ['- type: damageType', '  id: Blunt', ''].join('\n'), false],
  ['Resources/Prototypes/Items/sizes.yml', ['- type: itemSize', '  id: Small', ''].join('\n'), false],
  ['RobustToolbox/Resources/EnginePrototypes/base.yml', ['- type: entity', '  id: EngineBase', ''].join('\n'), true],
];

function readyIndex(): PrototypeIndex {
  const index = new PrototypeIndex();
  index.replaceAll(
    FORK.flatMap(([path, text, engine]): readonly PrototypeRecord[] => {
      const result = collectRecords(text, path, engine);
      if (!result.ok) throw new Error(`fixture ${path} did not parse`);
      return result.records;
    }),
  );
  return index;
}

const INDEX = readyIndex();

function check(lines: readonly string[], index: PrototypeIndex | undefined = INDEX) {
  const text = lines.join('\n') + '\n';
  return diagnosticsFor(text, SCHEMA, index).map((d: PrototypeDiagnostic) => ({
    code: d.code,
    text: text.slice(d.range[0], d.range[1]),
  }));
}

describe('diagnosticsFor — unknown components', () => {
  it('flags a component the schema does not know, on its name', () => {
    expect(check(['- type: entity', '  id: X', '  components:', '  - type: Item', '  - type: Itme'])).toEqual([
      { code: 'unknown-component', text: 'Itme' },
    ]);
  });

  it('leaves the prototype `type:` and field values that merely say "type" alone', () => {
    expect(check(['- type: entity', '  id: X', '  components:', '  - type: Sprite'])).toEqual([]);
  });
});

describe('diagnosticsFor — prototype references', () => {
  it('flags a `parent:` that names no prototype of that kind', () => {
    expect(check(['- type: entity', '  id: X', '  parent: BaseItme'])).toEqual([
      { code: 'unknown-prototype', text: 'BaseItme' },
    ]);
  });

  it('accepts abstract and engine parents, and every item of a parent list', () => {
    expect(check(['- type: entity', '  id: X', '  parent: [BaseItem, EngineBase]'])).toEqual([]);
  });

  it('flags only the missing items of a parent list', () => {
    expect(check(['- type: entity', '  id: X', '  parent:', '  - BaseItem', '  - Nope'])).toEqual([
      { code: 'unknown-prototype', text: 'Nope' },
    ]);
  });

  it('looks an id up under the field kind only: an entity id is no item size', () => {
    expect(check(['- type: entity', '  id: X', '  components:', '  - type: Item', '    size: FireAxe'])).toEqual([
      { code: 'unknown-prototype', text: 'FireAxe' },
    ]);
  });

  it('checks dictionary keys typed as prototype ids', () => {
    expect(
      check(['- type: entity', '  id: X', '  components:', '  - type: MeleeWeapon', '    damage:', '      types:', '        Blunt: 5', '        Blnt: 2']),
    ).toEqual([{ code: 'unknown-prototype', text: 'Blnt' }]);
  });

  it('says nothing about references until the index is ready', () => {
    expect(check(['- type: entity', '  id: X', '  parent: BaseItme'], new PrototypeIndex())).toEqual([]);
    expect(diagnosticsFor('- type: entity\n  id: X\n  parent: BaseItme\n', SCHEMA, undefined)).toEqual([]);
  });

  it('says nothing for a kind the index holds no record of at all', () => {
    // No `reagent` prototypes in the fork above: a kind mismatch, not a typo.
    expect(check(['- type: reagent', '  id: R', '  parent: Whatever'])).toEqual([]);
  });
});

describe('diagnosticsFor — enum values', () => {
  it('flags a value that is none of the enum names', () => {
    expect(check(['- type: entity', '  id: X', '  components:', '  - type: Physics', '    bodyStatus: Flying'])).toEqual([
      { code: 'invalid-enum-value', text: 'Flying' },
    ]);
  });

  it('reads values the way the engine does: any case, a number, or `A, B`', () => {
    for (const value of ['onground', 'InAir', '1', '"OnGround, InAir"']) {
      expect(check(['- type: entity', '  id: X', '  components:', '  - type: Physics', `    bodyStatus: ${value}`])).toEqual([]);
    }
  });

  it('checks every item of a flags list', () => {
    expect(
      check(['- type: entity', '  id: X', '  components:', '  - type: Clothing', '    slots:', '    - HEAD', '    - HEDA']),
    ).toEqual([{ code: 'invalid-enum-value', text: 'HEDA' }]);
  });
});

describe('diagnosticsFor — what it leaves alone', () => {
  it('returns nothing for a file that does not parse', () => {
    expect(check(['- type: entity', '  id: [X'])).toEqual([]);
  });

  it('ignores fields and components on prototype types the schema does not know', () => {
    expect(check(['- type: madeUpKind', '  id: X', '  parent: Nope'])).toEqual([]);
  });
});
