import { describe, expect, it } from 'vitest';

import { completionsAt, reopensSuggestAfterDeletion } from '../../src/core/completion';
import { parsedFixture, schemaSnapshot } from './prototype-fixtures';

/** Candidate assertions below name components/fields/enums present in the snapshot. */
const SCHEMA = schemaSnapshot();

/** Labels of the candidates, for set-style assertions. */
function labels(file: ReturnType<typeof parsedFixture>, offset: number): string[] {
  return completionsAt(file.text, offset, SCHEMA).map((c) => c.label);
}

describe('completionsAt — component names after `- type:`', () => {
  it('offers component names from the schema on the `type:` value slot', () => {
    const file = parsedFixture('completion_contexts.yml');
    const offset = file.text.indexOf('- type: Action') + '- type: Act'.length;

    const candidates = completionsAt(file.text, offset, SCHEMA);
    const action = candidates.find((c) => c.label === 'Action');

    expect(action).toEqual({ kind: 'component', label: 'Action', detail: 'ActionComponent' });
    // detail is the class short name, not the fully-qualified type.
    expect(action?.detail).not.toContain('.');
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['Sprite', 'MeleeWeapon']));
    expect(candidates.every((c) => c.kind === 'component')).toBe(true);
  });

  it('also fires inside fireaxe.yml, a real fork file', () => {
    const file = parsedFixture('fireaxe.yml');
    const offset = file.text.indexOf('- type: MeleeWeapon') + '- type: Mel'.length;

    expect(labels(file, offset)).toEqual(expect.arrayContaining(['MeleeWeapon', 'Sprite', 'Tag']));
  });
});

describe('completionsAt — component fields', () => {
  it('offers the component\'s fields and drops the ones already written in the block', () => {
    const file = parsedFixture('fireaxe.yml');
    // Caret on the `swingLeft` key inside `- type: MeleeWeapon`.
    const offset = file.text.indexOf('swingLeft: true') + 'swing'.length;

    const found = labels(file, offset);

    // Offered: real MeleeWeapon fields not yet present in this block.
    expect(found).toEqual(expect.arrayContaining(['swingLeft', 'range', 'angle', 'animation']));
    // Excluded: sibling keys already written in the same component block.
    expect(found).not.toContain('attackRate');
    expect(found).not.toContain('damage');
    expect(found).not.toContain('wideAnimationRotation');
    // Never the `type:` discriminator.
    expect(found).not.toContain('type');
    expect(completionsAt(file.text, offset, SCHEMA).every((c) => c.kind === 'field')).toBe(true);
  });
});

describe('completionsAt — nested DataDefinition fields', () => {
  it('offers the fields of the DataDefinition the key chain lands in', () => {
    const file = parsedFixture('completion_contexts.yml');
    // Caret on `superSlippery` inside `slipData:` (SlipperyEffectEntry) of a reagent.
    const offset = file.text.indexOf('superSlippery: true') + 'super'.length;

    const found = labels(file, offset);

    expect(found).toEqual(
      expect.arrayContaining(['superSlippery', 'stunTime', 'knockdownTime', 'autoStand']),
    );
    // `slipFriction` is already written in the block.
    expect(found).not.toContain('slipFriction');
    // Not reagent-prototype fields — we are inside the nested definition.
    expect(found).not.toContain('boilingPoint');
  });
});

describe('completionsAt — prototype fields by `[Prototype]` type', () => {
  it('offers ReagentPrototype fields for a `- type: reagent` document', () => {
    const file = parsedFixture('completion_contexts.yml');
    // Caret on the top-level `name` key of the reagent prototype.
    const offset = file.text.indexOf('  name: test chem') + '  na'.length;

    const found = labels(file, offset);

    expect(found).toEqual(expect.arrayContaining(['flavor', 'meltingPoint', 'specificHeat', 'color']));
    // Already-present top-level keys are excluded (the caret key `name` aside).
    expect(found).not.toContain('id');
    expect(found).not.toContain('boilingPoint');
    expect(found).not.toContain('slipData');
  });

  it('offers EntityPrototype fields for a `- type: entity` document', () => {
    const file = parsedFixture('fireaxe.yml');
    const offset = file.text.indexOf('  id: FireAxe') + '  i'.length;

    const found = labels(file, offset);
    expect(found).toEqual(expect.arrayContaining(['id', 'suffix', 'categories']));
    expect(found).not.toContain('name');
    expect(found).not.toContain('description');
  });
});

describe('completionsAt — enum values', () => {
  it('offers the enum members on an enum-typed field value', () => {
    const file = parsedFixture('completion_contexts.yml');
    const offset = file.text.indexOf('itemIconStyle: BigAction') + 'itemIconStyle: Big'.length;

    const candidates = completionsAt(file.text, offset, SCHEMA);
    expect(candidates.map((c) => c.label).sort()).toEqual(['BigAction', 'BigItem', 'NoItem']);
    expect(candidates.every((c) => c.kind === 'value')).toBe(true);
  });

  it('is empty on a non-enum field value', () => {
    const file = parsedFixture('completion_contexts.yml');
    const offset = file.text.indexOf('boilingPoint: 300') + 'boilingPoint: 3'.length;
    expect(completionsAt(file.text, offset, SCHEMA)).toEqual([]);
  });
});

/**
 * Mid-edit positions — a caret line with no `:` on it yet. These run over both
 * line endings: real fork files on Windows are CRLF, and the whole recovery path
 * is regex-driven, so a `\r` left on the line silently disables it (issue #27
 * follow-up — the first cut only ever ran against LF strings).
 */
describe.each([
  ['LF', '\n'],
  ['CRLF', '\r\n'],
])('completionsAt — mid-edit, %s', (_name, eol) => {
  /** Join lines with the EOL under test; the caret goes at the end of the last one. */
  function atEndOf(lines: readonly string[]): { text: string; offset: number } {
    const text = lines.join(eol) + eol;
    return { text, offset: lines.join(eol).length };
  }

  const meleeBlock = [
    '- type: entity',
    '  id: X',
    '  components:',
    '  - type: MeleeWeapon',
    '    attackRate: 1',
  ];

  it('offers component fields on a half-typed key with no colon, inserting the colon', () => {
    const { text, offset } = atEndOf([...meleeBlock, '    swingL']);

    const candidates = completionsAt(text, offset, SCHEMA);
    const swingLeft = candidates.find((c) => c.label === 'swingLeft');
    expect(swingLeft).toMatchObject({ label: 'swingLeft', kind: 'field', insertText: 'swingLeft: ' });
    expect(candidates.map((c) => c.label)).not.toContain('attackRate'); // sibling already written
  });

  it('offers component fields on a blank indented line (Ctrl+Space)', () => {
    const { text, offset } = atEndOf([...meleeBlock, '    ']);

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['swingLeft', 'range', 'damage']));
    expect(candidates.map((c) => c.label)).not.toContain('attackRate');
    // Every field carries its own colon so the caret lands on the value.
    expect(candidates.every((c) => c.insertText === `${c.label}: `)).toBe(true);
  });

  it('offers prototype fields on a blank line at the top level', () => {
    const { text, offset } = atEndOf(['- type: reagent', '  id: X', '  ']);

    const found = completionsAt(text, offset, SCHEMA).map((c) => c.label);
    expect(found).toEqual(expect.arrayContaining(['flavor', 'boilingPoint', 'color']));
    expect(found).not.toContain('id');
  });

  it('offers nested DataDefinition fields even when `yaml` mis-parsed the key as a scalar', () => {
    // `damage:` followed by a bare `t` — `yaml` reads it as `damage: "t"`, a
    // valid-looking scalar, so recovery must still kick in off the missing `:`.
    const { text, offset } = atEndOf([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: MeleeWeapon',
      '    damage:',
      '      t',
    ]);
    expect(completionsAt(text, offset, SCHEMA).map((c) => c.label)).toEqual(['types']);
  });

  it('does not offer field keys on a sequence-item line', () => {
    const { text } = atEndOf([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: GuideHelp',
      '    guides:',
      '    - CEMiningGuideEN',
    ]);
    const offset = text.indexOf('- CEMiningGuideEN') + '- CEMining'.length;
    expect(completionsAt(text, offset, SCHEMA)).toEqual([]);
  });

  it('leaves an existing `key: value` line to the direct parse, without a second colon', () => {
    const { text } = atEndOf([...meleeBlock, '    swingLeft: true']);
    const offset = text.indexOf('    swingLeft') + '    swing'.length;

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toContain('swingLeft');
    expect(candidates.map((c) => c.label)).not.toContain('attackRate');
    // The line already has its colon — candidates must not carry another.
    expect(candidates.every((c) => c.insertText === undefined)).toBe(true);
  });

  it('still offers enum values on a value slot', () => {
    const { text } = atEndOf([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: Action',
      '    itemIconStyle: Big',
    ]);
    const offset = text.indexOf('itemIconStyle: Big') + 'itemIconStyle: Big'.length;
    expect(completionsAt(text, offset, SCHEMA).map((c) => c.label).sort()).toEqual([
      'BigAction',
      'BigItem',
      'NoItem',
    ]);
  });

  it('offers values on an empty slot followed by the next component, not at the end of the file', () => {
    // `yaml` ends the component's map before the caret, so a direct read lands
    // on `components:` itself; the empty slot must still win.
    const lines = [
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: MeleeWeapon',
      '    swingLeft: ',
      '  - type: Sprite',
    ];
    const text = lines.join(eol) + eol;
    const offset = text.indexOf('swingLeft: ') + 'swingLeft: '.length;
    expect(completionsAt(text, offset, SCHEMA).map((c) => c.label)).toEqual(['false', 'true']);
  });

  it('returns [] when the document is unparseable and the line is not a key', () => {
    const { text, offset } = atEndOf(['- type: entity', '  id: X', '  : : broken']);
    expect(completionsAt(text, offset, SCHEMA)).toEqual([]);
  });

  it('offers component names on a bare `- `, inserting the `type:` it still needs', () => {
    const { text, offset } = atEndOf([...meleeBlock, '  - ']);

    const candidates = completionsAt(text, offset, SCHEMA);
    const sprite = candidates.find((c) => c.label === 'Sprite');
    expect(sprite).toEqual({
      label: 'Sprite',
      kind: 'component',
      detail: 'SpriteComponent',
      insertText: 'type: Sprite',
    });
    expect(candidates.every((c) => c.kind === 'component')).toBe(true);
  });

  it('re-supplies the space when the caret sits right against the dash', () => {
    const { text, offset } = atEndOf([...meleeBlock, '  -']);
    const sprite = completionsAt(text, offset, SCHEMA).find((c) => c.label === 'Sprite');
    expect(sprite?.insertText).toBe(' type: Sprite');
  });

  it('offers prototype types on a bare `- ` at the top level', () => {
    const { text, offset } = atEndOf(['- type: entity', '  id: X', '', '- ']);

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['entity', 'reagent']));
    expect(candidates.every((c) => c.kind === 'prototype')).toBe(true);
    expect(candidates.find((c) => c.label === 'reagent')?.insertText).toBe('type: reagent');
  });

  it('does not offer anything on a bare `- ` in a scalar sequence', () => {
    const { text, offset } = atEndOf([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: GuideHelp',
      '    guides:',
      '    - CEMiningGuideEN',
      '    - ',
    ]);
    expect(completionsAt(text, offset, SCHEMA)).toEqual([]);
  });
});

/**
 * The `type:` value of the prototype itself — the sibling of the component-name
 * point, one level out. Its empty-slot form (`- type: ` with nothing after)
 * needs the same recovery: that offset is past the end of every node range.
 */
describe.each([
  ['LF', '\n'],
  ['CRLF', '\r\n'],
])('completionsAt — prototype types, %s', (_name, eol) => {
  it('offers prototype types on a half-typed `- type: ent`', () => {
    const text = ['- type: entity', '  id: X', '', '- type: ent'].join(eol) + eol;
    const offset = text.lastIndexOf('ent') + 'ent'.length;

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['entity', 'reagent']));
    expect(candidates.every((c) => c.kind === 'prototype')).toBe(true);
    // The author already typed `type: `, so the label inserts as-is.
    expect(candidates.every((c) => c.insertText === undefined)).toBe(true);
  });

  it('offers prototype types on an empty `- type: ` slot', () => {
    const text = ['- type: entity', '  id: X', '', '- type: '].join(eol) + eol;
    const offset = text.length - eol.length;

    expect(completionsAt(text, offset, SCHEMA).map((c) => c.label)).toEqual(
      expect.arrayContaining(['entity', 'reagent', 'jobIcon']),
    );
  });

  it('still offers component names on an empty `type: ` slot inside components:', () => {
    const text =
      ['- type: entity', '  id: X', '  components:', '  - type: '].join(eol) + eol;
    const offset = text.length - eol.length;

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['Sprite', 'MeleeWeapon']));
    expect(candidates.every((c) => c.kind === 'component')).toBe(true);
  });
});

/**
 * `ComponentRegistry` is an ordinary field type, not a structural feature of the
 * document. `entity` calls its registry `components`, but the engine has ten such
 * tags and a prototype may declare several — so the completion must key off
 * `fieldKind`, never off the name `components`.
 */
describe('completionsAt — component registries other than `components`', () => {
  const borg = [
    '- type: borgType',
    '  id: X',
    '  addComponents:',
    '  - type: Sprite',
    '    sprite: a.rsi',
  ];

  it('offers component names in `addComponents:` of borgType', () => {
    const text = borg.join('\n') + '\n';
    const offset = text.indexOf('- type: Sprite') + '- type: Spr'.length;

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['Sprite', 'MeleeWeapon']));
    expect(candidates.every((c) => c.kind === 'component')).toBe(true);
  });

  it('offers that component\'s fields inside `addComponents:`', () => {
    const text = borg.join('\n') + '\n';
    const offset = text.indexOf('    sprite: a.rsi') + '    spr'.length;

    const found = completionsAt(text, offset, SCHEMA).map((c) => c.label);
    expect(found).toEqual(expect.arrayContaining(['sprite', 'color', 'layers']));
    // Not borgType's own fields — the caret is inside a component.
    expect(found).not.toContain('addComponents');
  });

  it('offers component names on a bare `- ` in `addComponents:`', () => {
    const text = borg.join('\n') + '\n  - \n';
    const offset = text.length - 1;

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.every((c) => c.kind === 'component')).toBe(true);
    expect(candidates.find((c) => c.label === 'Sprite')?.insertText).toBe('type: Sprite');
  });

  it('handles a prototype declaring more than one registry', () => {
    const text =
      ['- type: antagSpecifier', '  id: X', '  mindComponents:', '  - type: Sprite', '    sprite: a.rsi'].join('\n') +
      '\n';
    const offset = text.indexOf('    sprite: a.rsi') + '    spr'.length;

    expect(completionsAt(text, offset, SCHEMA).map((c) => c.label)).toContain('color');
  });

  it('does not read a `components:` key as a registry on a prototype that has no such field', () => {
    // borgType's registry is `addComponents`; a literal `components:` here is not one.
    const text =
      ['- type: borgType', '  id: X', '  components:', '  - type: Sprite', '    sprite: a.rsi'].join('\n') + '\n';
    const offset = text.indexOf('    sprite: a.rsi') + '    spr'.length;

    expect(completionsAt(text, offset, SCHEMA)).toEqual([]);
  });
});

/**
 * Value candidates are chosen by the field's declared `fieldKind`, so every kind
 * whose whole domain is in the schema is served the same way — `boolean` is not
 * a special case bolted next to `enum`.
 */
/**
 * A dictionary key is data, not a field name — `events:` keys a
 * `Dictionary<TimeSpan, List<CEEntityEffect>>` by time — so the chain steps over
 * it into the dictionary's value type.
 */
describe('completionsAt — below a dictionary key', () => {
  const animation = [
    '- type: entityEffectAnimation',
    '  id: X',
    '  events:',
    '    0:',
    '    - !type:SpawnEntity',
    '      spawns: []',
  ];

  function atEnd(lines: readonly string[]): { text: string; offset: number } {
    const joined = lines.join('\n');
    return { text: joined + '\n', offset: joined.length };
  }

  it('offers the tagged effect\'s fields', () => {
    const { text, offset } = atEnd([...animation, '      ']);
    const found = completionsAt(text, offset, SCHEMA).map((c) => c.label);
    expect(found).toEqual(expect.arrayContaining(['effectTarget', 'reparent']));
    expect(found).not.toContain('spawns'); // already written
  });

  it('offers enum members on a field value there', () => {
    const { text, offset } = atEnd([...animation, '      effectTarget: ']);
    expect(completionsAt(text, offset, SCHEMA).map((c) => c.label)).toContain('User');
  });

  it('offers no field names on the dictionary key itself', () => {
    const { text, offset } = atEnd(['- type: entityEffectAnimation', '  id: X', '  events:', '    ']);
    expect(completionsAt(text, offset, SCHEMA)).toEqual([]);
  });
});

describe('completionsAt — values by field kind', () => {
  /** `lines` with the caret at the end of the last one. */
  function atEnd(lines: readonly string[]): { text: string; offset: number } {
    const joined = lines.join('\n');
    return { text: joined + '\n', offset: joined.length };
  }

  it('offers true/false on a boolean component field', () => {
    const { text, offset } = atEnd([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: MeleeWeapon',
      '    swingLeft: ',
    ]);

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates).toEqual([
      { label: 'false', kind: 'value', detail: 'Boolean' },
      { label: 'true', kind: 'value', detail: 'Boolean' },
    ]);
  });

  it('offers true/false on a boolean prototype field', () => {
    const { text, offset } = atEnd(['- type: entity', '  id: X', '  abstract: ']);
    expect(completionsAt(text, offset, SCHEMA).map((c) => c.label)).toEqual(['false', 'true']);
  });

  it('offers the enum members of a `flags` field', () => {
    const { text, offset } = atEnd([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: StorageVoiceControl',
      '    allowedSlots: ',
    ]);

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['HEAD', 'EYES', 'MASK']));
    // The assembly-qualified generic type still reduces to one word.
    expect(candidates[0]?.detail).toBe('SlotFlags');
  });

  it('reads a list-of-enum field through its element type', () => {
    const { text, offset } = atEnd([
      '- type: entity',
      '  id: X',
      '  components:',
      '  - type: GasLeakRule',
      '    leakableGases: ',
    ]);

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['Oxygen', 'Plasma']));
    expect(candidates.every((c) => c.detail === 'Gas')).toBe(true);
  });

  it.each([
    ['float', ['  - type: MeleeWeapon', '    attackRate: ']],
    ['text', ['  - type: Sprite', '    sprite: ']],
    ['protoId', ['  - type: Item', '    size: ']],
  ])('offers nothing for a %s field, whose domain is not in the schema', (_kind, tail) => {
    const { text, offset } = atEnd(['- type: entity', '  id: X', '  components:', ...tail]);
    expect(completionsAt(text, offset, SCHEMA)).toEqual([]);
  });
});

describe('completionsAt — nothing to offer', () => {
  it('returns [] outside every prototype', () => {
    const file = parsedFixture('completion_contexts.yml');
    expect(completionsAt(file.text, file.text.length + 50, SCHEMA)).toEqual([]);
  });

  it('returns [] when the prototype type is not in the schema', () => {
    const nakedSchema = { ...SCHEMA, prototypes: {}, components: {} };
    const file = parsedFixture('fireaxe.yml');
    const offset = file.text.indexOf('  id: FireAxe') + '  i'.length;
    expect(completionsAt(file.text, offset, nakedSchema)).toEqual([]);
  });
});
/**
 * A `ComponentRegistry` is a field type, so it sits wherever a field can — not
 * only as `components:` on the prototype. The caret inside any of them is inside
 * a component and completes against that component, however deep the registry
 * was reached (issue #27 follow-up: the first cut only looked at prototype-level
 * keys, so `conversionComponents:` on a component completed nothing).
 */
describe('completionsAt — registries nested below the prototype', () => {
  const file = parsedFixture('nested_registries.yml');

  /** Caret just after `prefix`, which must occur exactly once in the fixture. */
  function caretAfter(prefix: string): number {
    const at = file.text.indexOf(prefix);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(file.text.indexOf(prefix, at + 1)).toBe(-1);
    return at + prefix.length;
  }

  describe('a registry declared by a component', () => {
    it('offers component names inside it', () => {
      const candidates = completionsAt(file.text, caretAfter('    - type: Spr'), SCHEMA);

      expect(candidates.map((c) => c.label)).toEqual(
        expect.arrayContaining(['Sprite', 'MeleeWeapon']),
      );
      expect(candidates.every((c) => c.kind === 'component')).toBe(true);
    });

    it('offers the inner component\'s fields, not the outer one\'s', () => {
      const found = labels(file, caretAfter('      spr'));

      expect(found).toEqual(expect.arrayContaining(['sprite', 'color', 'layers']));
      // ComponentToggler's own fields, and the entity's, are both out of scope.
      expect(found).not.toContain('removeComponents');
      expect(found).not.toContain('categories');
    });

    it('reads the second registry of the same component as one too', () => {
      const candidates = completionsAt(file.text, caretAfter('    - type: T'), SCHEMA);
      expect(candidates.every((c) => c.kind === 'component')).toBe(true);
      expect(candidates.map((c) => c.label)).toContain('Tag');
    });

    it('still offers the outer component\'s own fields on the registry key itself', () => {
      const found = labels(file, caretAfter('    removeCompon'));

      expect(found).toEqual(expect.arrayContaining(['netsync', 'removeComponents']));
      // Already written in this block.
      expect(found).not.toContain('components');
    });
  });

  describe('a registry inside a [DataDefinition] list', () => {
    it('offers the definition\'s own fields on the list item', () => {
      const found = labels(file, caretAfter('  - na'));

      expect(found).toEqual(expect.arrayContaining(['slotTexture', 'slotFlags', 'stripTime']));
      // Not inventoryTemplate's fields — the caret is inside a SlotDefinition.
      expect(found).not.toContain('slots');
    });

    it('offers component names in the registry that definition declares', () => {
      const candidates = completionsAt(file.text, caretAfter('    - type: It'), SCHEMA);

      expect(candidates.every((c) => c.kind === 'component')).toBe(true);
      expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['Item', 'Sprite']));
    });

    it('offers that component\'s fields', () => {
      const found = labels(file, caretAfter('      si'));

      expect(found).toEqual(expect.arrayContaining(['size', 'shape']));
      expect(found).not.toContain('dependsOnComponents');
    });
  });

  describe('a registry inside a `!type:` union member', () => {
    it('offers the tagged member\'s fields, which the abstract base does not have', () => {
      const found = labels(file, caretAfter('    removeExist'));

      expect(found).toEqual(['removeExisting']); // `components` is already written
      // Not the job prototype's fields — the caret is inside the union member.
      expect(found).not.toContain('startingGear');
    });

    it('offers component names in the registry that member declares', () => {
      const candidates = completionsAt(file.text, caretAfter('    - type: Mel'), SCHEMA);

      expect(candidates.every((c) => c.kind === 'component')).toBe(true);
      expect(candidates.map((c) => c.label)).toContain('MeleeWeapon');
    });

    it('offers that component\'s fields', () => {
      const found = labels(file, caretAfter('      attackR'));

      expect(found).toEqual(expect.arrayContaining(['attackRate', 'range', 'damage']));
      expect(found).not.toContain('removeExisting');
    });
  });
});

/** The mid-edit recovery has to reach a nested registry just as it reaches `components:`. */
describe.each([
  ['LF', '\n'],
  ['CRLF', '\r\n'],
])('completionsAt — mid-edit inside a nested registry, %s', (_name, eol) => {
  const toggler = [
    '- type: entity',
    '  id: X',
    '  components:',
    '  - type: ComponentToggler',
    '    removeComponents:',
    '    - type: Sprite',
    '      sprite: a.rsi',
  ];

  /** `lines` joined with the EOL under test, caret at the end of the last one. */
  function atEndOf(lines: readonly string[]): { text: string; offset: number } {
    const joined = lines.join(eol);
    return { text: joined + eol, offset: joined.length };
  }

  it('offers component names on a bare `- `, with the `type:` it still needs', () => {
    const { text, offset } = atEndOf([...toggler, '    - ']);

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.every((c) => c.kind === 'component')).toBe(true);
    expect(candidates.find((c) => c.label === 'Sprite')?.insertText).toBe('type: Sprite');
  });

  it('offers component names on an empty `- type: ` slot', () => {
    const { text, offset } = atEndOf([...toggler, '    - type: ']);

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['Sprite', 'MeleeWeapon']));
    expect(candidates.every((c) => c.kind === 'component')).toBe(true);
  });

  it('offers the inner component\'s fields on a half-typed key', () => {
    const { text, offset } = atEndOf([...toggler, '      col']);

    const candidates = completionsAt(text, offset, SCHEMA);
    expect(candidates.map((c) => c.label)).toContain('color');
    expect(candidates.map((c) => c.label)).not.toContain('sprite'); // already written
    expect(candidates.every((c) => c.insertText === `${c.label}: `)).toBe(true);
  });
});

/**
 * VS Code never opens suggestions on a deletion, so backspacing into a wrong
 * value shows nothing until the next letter. The host asks this predicate after
 * each deletion and reopens the list itself (issue #33 follow-up).
 */
describe('reopensSuggestAfterDeletion', () => {
  function caretAtEnd(lines: readonly string[]): { text: string; offset: number } {
    const joined = lines.join('\n');
    return { text: joined + '\n', offset: joined.length };
  }

  it.each([
    ['a prototype type', ['- type: ent']],
    ['a component name', ['- type: entity', '  id: X', '  components:', '  - type: Spri']],
    ['a field key', ['- type: entity', '  id: X', '  components:', '  - type: MeleeWeapon', '    swingL']],
    ['an enum value', ['- type: entity', '  id: X', '  components:', '  - type: Action', '    itemIconStyle: Bi']],
    ['an emptied value slot', ['- type: ']],
  ])('reopens inside %s', (_name, lines) => {
    const { text, offset } = caretAtEnd(lines);
    expect(reopensSuggestAfterDeletion(text, offset, SCHEMA)).toBe(true);
  });

  it('stays closed on a blank line, so deleting lines does not pop the list', () => {
    const { text, offset } = caretAtEnd(['- type: entity', '  id: X', '  ']);
    expect(reopensSuggestAfterDeletion(text, offset, SCHEMA)).toBe(false);
  });

  it('stays closed where there is nothing to offer', () => {
    const { text, offset } = caretAtEnd(['- type: entity', '  id: X', '  name: fo']);
    expect(reopensSuggestAfterDeletion(text, offset, SCHEMA)).toBe(false);
  });
});

describe('completionsAt — `!type:` members of a polymorphic slot (#43)', () => {
  const claw = parsedFixture('claw.yml');
  const CE_EFFECT = 'Content.Shared._CE.EntityEffect.CEEntityEffect';
  const INSTANT_EVENT = 'Content.Shared.Actions.InstantActionEvent';

  /** `text` with the first `find` replaced by `replace`; the caret goes after `caretAfter` in the replacement. */
  function edited(text: string, find: string, replace: string, caretAfter = replace) {
    const at = text.indexOf(find);
    expect(at).toBeGreaterThanOrEqual(0);
    return { text: text.slice(0, at) + replace + text.slice(at + find.length), offset: at + caretAfter.length };
  }

  function shortNames(base: string): string[] {
    return SCHEMA.polymorphicTypes[base].map((full) => full.slice(full.lastIndexOf('.') + 1)).sort();
  }

  it('on a written tag, offers every member of the list\'s element type, replacing the whole tag', () => {
    const tagStart = claw.text.indexOf('!type:WeaponArcAttack');
    const typed = '!type:WeaponArc';
    const candidates = completionsAt(claw.text, tagStart + typed.length, SCHEMA);

    expect(candidates.map((c) => c.label).sort()).toEqual(shortNames(CE_EFFECT));
    expect(candidates.find((c) => c.label === 'WeaponArcAttack')).toEqual({
      label: 'WeaponArcAttack',
      kind: 'type',
      detail: 'Content.Shared._CE.EntityEffect.Effects.WeaponArcAttack',
      insertText: '!type:WeaponArcAttack',
      range: [tagStart, tagStart + '!type:WeaponArcAttack'.length],
    });
    // The host filters on the insert text against what is typed in the range.
    const matching = candidates.filter((c) => c.insertText?.startsWith(typed)).map((c) => c.label);
    expect(matching).toEqual(['WeaponArcAttack']);
  });

  it('on an empty `!type:` list item, offers the whole list', () => {
    const { text, offset } = edited(claw.text, '- !type:Knockdown', '- !type:');
    const candidates = completionsAt(text, offset, SCHEMA);

    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(['Damage', 'Knockdown', 'ThrowFrom']));
    expect(candidates).toHaveLength(SCHEMA.polymorphicTypes[CE_EFFECT].length);
    expect(candidates[0].range).toEqual([offset - '!type:'.length, offset]);
  });

  it('on a bare `- ` in a list of effects, inserts the whole tag', () => {
    const { text, offset } = edited(claw.text, '      - !type:ThrowFrom', '      - \r\n      - !type:ThrowFrom', '      - ');
    const damage = completionsAt(text, offset, SCHEMA).find((c) => c.label === 'Damage');

    expect(damage).toEqual({
      label: 'Damage',
      kind: 'type',
      detail: 'Content.Shared._CE.EntityEffect.Effects.Damage',
      insertText: '!type:Damage',
    });
  });

  it('right against the dash, re-supplies the space', () => {
    const { text, offset } = edited(claw.text, '      - !type:ThrowFrom', '      -\r\n      - !type:ThrowFrom', '      -');

    expect(completionsAt(text, offset, SCHEMA).find((c) => c.label === 'Damage')?.insertText).toBe(' !type:Damage');
  });

  it('on an `event:` tag, offers the members of the event type the field declares', () => {
    const types = parsedFixture('types.yml');
    const offset = types.text.indexOf('!type:ToggleActionEvent') + '!type:Tog'.length;
    const candidates = completionsAt(types.text, offset, SCHEMA);

    expect(candidates.map((c) => c.label).sort()).toEqual(shortNames(INSTANT_EVENT));
    expect(candidates.map((c) => c.label)).toContain('ToggleActionEvent');
  });

  it('on an empty `event: ` slot, inserts the whole tag', () => {
    const types = parsedFixture('types.yml');
    const { text, offset } = edited(types.text, 'event: !type:ToggleActionEvent', 'event: ');
    const toggle = completionsAt(text, offset, SCHEMA).find((c) => c.label === 'ToggleActionEvent');

    expect(toggle).toEqual({
      label: 'ToggleActionEvent',
      kind: 'type',
      detail: 'Content.Shared.Toggleable.ToggleActionEvent',
      insertText: '!type:ToggleActionEvent',
    });
  });

  it('right after `event:` with no space yet, re-supplies it', () => {
    const types = parsedFixture('types.yml');
    const { text, offset } = edited(types.text, 'event: !type:ToggleActionEvent', 'event:');

    expect(completionsAt(text, offset, SCHEMA).find((c) => c.label === 'ToggleActionEvent')?.insertText).toBe(
      ' !type:ToggleActionEvent',
    );
  });

  it('offers a DoAfterEvent field the members of DoAfterEvent', () => {
    const doAfterEvent = SCHEMA.dataDefinitions['Content.Shared.DoAfter.DoAfterArgs'].fields.find(
      (f) => f.tag === 'event',
    )!;
    // No prototype reaches a DoAfterArgs in this fork, so hang its field on a probe component.
    const schema = {
      ...SCHEMA,
      components: { ...SCHEMA.components, Probe: { className: 'Probe', name: 'Probe', fields: [doAfterEvent] } },
    };
    const text = '- type: entity\n  id: X\n  components:\n  - type: Probe\n    event: \n';
    const offset = text.indexOf('event: ') + 'event: '.length;

    expect(completionsAt(text, offset, schema).map((c) => c.label)).toEqual(
      expect.arrayContaining(['CECraftDoAfterEvent', 'HealingDoAfterEvent']),
    );
  });

  it('offers a `sound:` the two SoundSpecifier members', () => {
    const alerts = parsedFixture('alert_levels.yml');
    const { text, offset } = edited(alerts.text, 'sound: /Audio/Misc/bluealert.ogg', 'sound: ');
    const candidates = completionsAt(text, offset, SCHEMA);

    expect(candidates.map((c) => [c.label, c.detail, c.insertText])).toEqual([
      ['SoundCollectionSpecifier', 'Robust.Shared.Audio.SoundCollectionSpecifier', '!type:SoundCollectionSpecifier'],
      ['SoundPathSpecifier', 'Robust.Shared.Audio.SoundPathSpecifier', '!type:SoundPathSpecifier'],
    ]);
  });

  it('offers them too on `sound:` whose map is already written below', () => {
    const drinks = parsedFixture('drinks_bottles_plastic.yml');
    const offset = drinks.text.indexOf('    sound:') + '    sound:'.length;

    expect(completionsAt(drinks.text, offset, SCHEMA).map((c) => c.insertText)).toEqual([
      ' !type:SoundCollectionSpecifier',
      ' !type:SoundPathSpecifier',
    ]);
  });

  it('never offers a member the CLI saw as abstract', () => {
    const types = parsedFixture('types.yml');
    const { text, offset } = edited(types.text, 'event: !type:ToggleActionEvent', 'event: !type:');
    const labels = completionsAt(text, offset, SCHEMA).map((c) => c.label);

    expect(labels).not.toContain('InstantActionEvent');
    expect(labels).not.toContain('BaseActionEvent');
  });

  it('stays silent on a field that is not polymorphic', () => {
    const empty = edited(claw.text, 'arcWidth: 40', 'arcWidth: ');
    expect(completionsAt(empty.text, empty.offset, SCHEMA)).toEqual([]);

    const tagged = edited(claw.text, 'arcWidth: 40', 'arcWidth: !type:');
    expect(completionsAt(tagged.text, tagged.offset, SCHEMA)).toEqual([]);
  });
});

describe('reopensSuggestAfterDeletion — on an emptied `!type:` tag (#43)', () => {
  it('reopens once the member name is deleted back to `!type:`', () => {
    const claw = parsedFixture('claw.yml');
    const at = claw.text.indexOf('!type:Knockdown');
    const text = claw.text.slice(0, at) + '!type:' + claw.text.slice(at + '!type:Knockdown'.length);

    expect(reopensSuggestAfterDeletion(text, at + '!type:'.length, SCHEMA)).toBe(true);
  });
});

describe('completionsAt — blank line in a list of union members (#43)', () => {
  const claw = parsedFixture('claw.yml');

  it('between two items, offers the members with the dash and the tag', () => {
    const at = claw.text.indexOf('      - !type:ThrowFrom');
    const text = claw.text.slice(0, at) + '      \r\n' + claw.text.slice(at);
    const damage = completionsAt(text, at + '      '.length, SCHEMA).find((c) => c.label === 'Damage');

    expect(damage?.insertText).toBe('- !type:Damage');
  });

  it('after the last item, stays a key of the enclosing map', () => {
    const anchor = '      - !type:WeaponEffectSlot\r\n        slot: OnHit\r\n';
    const at = claw.text.indexOf(anchor) + anchor.length;
    const text = claw.text.slice(0, at) + '      \r\n' + claw.text.slice(at);
    const candidates = completionsAt(text, at + '      '.length, SCHEMA);

    expect(candidates.some((c) => c.kind === 'type')).toBe(false);
  });
});
