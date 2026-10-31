import { describe, expect, it } from 'vitest';

import { hoverAt, hoverMarkdown, readableTypeName } from '../../src/core/hover';
import type { SchemaRoot } from '../../src/core/schema-contract';
import { schemaSnapshot } from './prototype-fixtures';

/**
 * Hover over a component name, a `!type:` tag or a field (issue #30). The text
 * is asked of the core as data — what is named, its C# type, summary and
 * default — and as the markdown the host shows. The committed crystall-edge
 * snapshot carries no XML-doc summaries (that build emits no `.xml` files), so
 * the summary cases patch one into a copy of it.
 */
const SCHEMA = schemaSnapshot();

const DESTRUCTIBLE = [
  '- type: entity',
  '  id: Crate',
  '  name: crate',
  '  parent: BaseStructure',
  '  components:',
  '  - type: Destructible',
  '    isBroken: false',
  '    thresholds:',
  '    - trigger:',
  '        !type:DamageTypeTrigger',
  '        damageType: Heat',
  '        damage: 20',
  '  - type: Damageable',
  '    damageModifierSet: Metallic',
  '',
].join('\n');

/** Offset `into` characters past the start of the first `needle` in `text`. */
function at(text: string, needle: string, into = 1): number {
  const index = text.indexOf(needle);
  if (index === -1) throw new Error(`"${needle}" not in text`);
  return index + into;
}

const TRIGGER = 'Content.Shared.Destructible.Thresholds.Triggers.DamageTypeTrigger';

/** The snapshot with summaries on Destructible, its `isBroken` field and DamageTypeTrigger. */
function documented(): SchemaRoot {
  const destructible = SCHEMA.components.Destructible;
  const trigger = SCHEMA.dataDefinitions[TRIGGER];
  return {
    ...SCHEMA,
    components: {
      ...SCHEMA.components,
      Destructible: {
        ...destructible,
        summary: 'Destroys the entity once damage crosses a threshold.',
        fields: destructible.fields.map((f) =>
          f.tag === 'isBroken' ? { ...f, summary: 'Whether the entity is <b>broken</b>.' } : f,
        ),
      },
    },
    dataDefinitions: {
      ...SCHEMA.dataDefinitions,
      [TRIGGER]: { ...trigger, summary: 'Triggers on damage of one type.' },
    },
  };
}

describe('hoverAt — component names', () => {
  it('names the component, its class and its summary', () => {
    const offset = at(DESTRUCTIBLE, 'Destructible', 4);
    const hover = hoverAt(DESTRUCTIBLE, offset, documented());

    expect(hover).toEqual({
      origin: [DESTRUCTIBLE.indexOf('Destructible'), DESTRUCTIBLE.indexOf('Destructible') + 'Destructible'.length],
      kind: 'component',
      name: 'Destructible',
      type: 'Content.Server.Destructible.DestructibleComponent',
      summary: 'Destroys the entity once damage crosses a threshold.',
    });
  });

  it('still names the class of an undocumented component', () => {
    const hover = hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'Damageable', 2), SCHEMA);
    expect(hover).toMatchObject({ kind: 'component', name: 'Damageable', summary: null });
    expect(hover?.type).toMatch(/\.DamageableComponent$/);
  });

  it('is empty for a component the schema does not know', () => {
    const text = '- type: entity\n  id: X\n  components:\n  - type: NoSuchThing\n';
    expect(hoverAt(text, at(text, 'NoSuchThing', 3), SCHEMA)).toBeNull();
  });
});

describe('hoverAt — fields', () => {
  it('shows a component field’s summary, type and default', () => {
    const offset = at(DESTRUCTIBLE, 'isBroken', 3);
    expect(hoverAt(DESTRUCTIBLE, offset, documented())).toEqual({
      origin: [DESTRUCTIBLE.indexOf('isBroken'), DESTRUCTIBLE.indexOf('isBroken') + 'isBroken'.length],
      kind: 'field',
      name: 'isBroken',
      type: 'bool',
      summary: 'Whether the entity is <b>broken</b>.',
      default: 'false',
      required: false,
      member: 'IsBroken',
      owner: 'Content.Server.Destructible.DestructibleComponent',
    });
  });

  it('shows the type of an undocumented field, with its default', () => {
    expect(hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'thresholds'), SCHEMA)).toMatchObject({
      name: 'thresholds',
      type: 'List<DamageThreshold>',
      summary: null,
      default: '[]',
    });
  });

  it('reads a field of the union member a `!type:` tag picks', () => {
    expect(hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'damageType'), SCHEMA)).toMatchObject({
      kind: 'field',
      name: 'damageType',
      type: 'ProtoId<DamageTypePrototype>',
      default: null,
      required: true,
    });
    expect(hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'damage:'), SCHEMA)).toMatchObject({
      name: 'damage',
      type: 'FixedPoint2',
    });
  });

  it('reads the prototype’s own fields', () => {
    expect(hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'parent'), SCHEMA)).toMatchObject({
      kind: 'field',
      name: 'parent',
      type: 'string[]',
      default: '[]',
    });
    expect(hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'name:'), SCHEMA)).toMatchObject({
      kind: 'field',
      name: 'name',
      type: 'string',
      default: null,
    });
  });

  it('answers with the caret at either end of the key', () => {
    const start = DESTRUCTIBLE.indexOf('isBroken');
    expect(hoverAt(DESTRUCTIBLE, start, SCHEMA)?.name).toBe('isBroken');
    expect(hoverAt(DESTRUCTIBLE, start + 'isBroken'.length, SCHEMA)?.name).toBe('isBroken');
  });
});

describe('hoverAt — `!type:` tags', () => {
  it('names the union member the tag picks, with its summary', () => {
    const tag = DESTRUCTIBLE.indexOf('DamageTypeTrigger');
    expect(hoverAt(DESTRUCTIBLE, tag + 3, documented())).toEqual({
      origin: [tag, tag + 'DamageTypeTrigger'.length],
      kind: 'type',
      name: 'DamageTypeTrigger',
      type: TRIGGER,
      summary: 'Triggers on damage of one type.',
    });
  });

  it('reads a tag written inline after its key, and its fields', () => {
    const text = DESTRUCTIBLE.replace('trigger:\n        !type:', 'trigger: !type:');
    expect(hoverAt(text, at(text, 'DamageTypeTrigger'), SCHEMA)).toMatchObject({ kind: 'type', type: TRIGGER });
    expect(hoverAt(text, at(text, 'damageType'), SCHEMA)).toMatchObject({ kind: 'field', name: 'damageType' });
  });

  it('reads a tag on a list item', () => {
    const text = [
      '- type: entity',
      '  id: Crate',
      '  components:',
      '  - type: Destructible',
      '    thresholds:',
      '    - behaviors:',
      '      - !type:DoActsBehavior',
      '        acts: [ "Destruction" ]',
      '',
    ].join('\n');
    expect(hoverAt(text, at(text, 'DoActsBehavior'), SCHEMA)).toMatchObject({ kind: 'type', name: 'DoActsBehavior' });
    expect(hoverAt(text, at(text, 'acts'), SCHEMA)).toMatchObject({ kind: 'field', name: 'acts' });
  });

  it('is empty for a tag naming no member of the declared union', () => {
    const text = DESTRUCTIBLE.replace('!type:DamageTypeTrigger', '!type:NoSuchTrigger');
    expect(hoverAt(text, at(text, 'NoSuchTrigger'), SCHEMA)).toBeNull();
  });
});

describe('hoverAt — outside a component or field', () => {
  it.each([
    ['a field value', 'Heat'],
    ['the prototype id', 'Crate'],
    ['the prototype type', 'entity'],
    ['a prototype-id value', 'Metallic'],
  ])('is empty on %s', (_what, needle) => {
    expect(hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, needle), SCHEMA)).toBeNull();
  });

  it('is empty on a key the schema has no field for', () => {
    const text = DESTRUCTIBLE.replace('isBroken: false', 'noSuchField: 1');
    expect(hoverAt(text, at(text, 'noSuchField'), SCHEMA)).toBeNull();
  });

  it('is empty on a dictionary key', () => {
    const text = '- type: damageModifierSet\n  id: M\n  coefficients:\n    Blunt: 0.5\n';
    expect(hoverAt(text, at(text, 'Blunt'), SCHEMA)).toBeNull();
  });

  it('is empty on a file that does not parse', () => {
    const text = '- type: entity\n  id: [unclosed\n';
    expect(hoverAt(text, at(text, 'id'), SCHEMA)).toBeNull();
  });
});

describe('hoverMarkdown', () => {
  it('renders the signature with its default, then the escaped summary', () => {
    const hover = hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'isBroken'), documented())!;
    expect(hoverMarkdown(hover)).toBe(
      ['```csharp', '(field) bool isBroken = false', '```', '', 'Whether the entity is \\<b\\>broken\\</b\\>\\.'].join(
        '\n',
      ),
    );
  });

  it('drops the default from a field without one and marks it required', () => {
    const hover = hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'damageType'), SCHEMA)!;
    expect(hoverMarkdown(hover)).toBe(
      ['```csharp', '(field) ProtoId<DamageTypePrototype> damageType', '```', '', '*required*'].join('\n'),
    );
  });

  it('renders a component as its class', () => {
    const hover = hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'Destructible'), documented())!;
    expect(hoverMarkdown(hover)).toBe(
      [
        '```csharp',
        '(component) Content.Server.Destructible.DestructibleComponent',
        '```',
        '',
        'Destroys the entity once damage crosses a threshold\\.',
      ].join('\n'),
    );
  });

  it('renders a `!type:` member as its class, alone when undocumented', () => {
    const hover = hoverAt(DESTRUCTIBLE, at(DESTRUCTIBLE, 'DamageTypeTrigger'), SCHEMA)!;
    expect(hoverMarkdown(hover)).toBe(['```csharp', `(type) ${TRIGGER}`, '```'].join('\n'));
  });
});

describe('readableTypeName', () => {
  it.each([
    ['System.Boolean', 'bool'],
    ['System.String[]', 'string[]'],
    ['Content.Shared.FixedPoint.FixedPoint2', 'FixedPoint2'],
    [
      'System.Collections.Generic.List`1[[Content.Server.Destructible.Thresholds.DamageThreshold, Content.Server, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null]]',
      'List<DamageThreshold>',
    ],
    [
      'System.Collections.Generic.Dictionary`2[[System.String, System.Private.CoreLib, Version=8.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e],[System.Collections.Generic.List`1[[System.Int32, System.Private.CoreLib, Version=8.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e]], System.Private.CoreLib, Version=8.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e]]',
      'Dictionary<string, List<int>>',
    ],
    [
      'System.Nullable`1[[Content.Shared.Inventory.SlotFlags, Content.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null]]',
      'SlotFlags?',
    ],
    ['Content.Shared.Weapons.Ranged.Systems.SharedGunSystem+CycleModeEvent', 'SharedGunSystem.CycleModeEvent'],
    ['System.Int32[,]', 'int[,]'],
  ])('%s -> %s', (full, readable) => {
    expect(readableTypeName(full)).toBe(readable);
  });
});
