import { describe, expect, it } from 'vitest';

import { cursorContextAt, parsePrototypeFile, positionAt } from '../../src/core/prototype-yaml';
import { parsedFixture } from './prototype-fixtures';

describe('cursorContextAt — offset to context', () => {
  const fireaxe = parsedFixture('fireaxe.yml');

  it('inside components:, on the `- type:` slot', () => {
    const offset = fireaxe.text.indexOf('type: Tag') + 'type: T'.length;
    const ctx = cursorContextAt(fireaxe, offset);

    expect(ctx.entityIndex).toBe(0);
    expect(ctx.prototypeType).toBe('entity');
    expect(ctx.component).toBe('Tag');
    expect(ctx.fieldPath).toEqual([]);
    expect(ctx.token).toEqual({ kind: 'component-type', text: 'Tag' });
  });

  it('on the `type` key itself (not its value) reports a key token, not component-type', () => {
    const offset = fireaxe.text.indexOf('- type: Tag') + '- ty'.length;
    const ctx = cursorContextAt(fireaxe, offset);

    expect(ctx.entityIndex).toBe(0);
    expect(ctx.component).toBe('Tag');
    expect(ctx.fieldPath).toEqual(['type']);
    expect(ctx.token).toEqual({ kind: 'key', name: 'type' });
  });

  it('in the gap between a `key:` and its value still lands on that field', () => {
    const offset = fireaxe.text.indexOf('description: Truly') + 'description:'.length;
    const ctx = cursorContextAt(fireaxe, offset);

    expect(ctx.entityIndex).toBe(0);
    expect(ctx.component).toBeNull();
    expect(ctx.fieldPath).toEqual(['description']);
    expect(ctx.token).toEqual({ kind: 'value' });
  });

  it('on a component field key', () => {
    const offset = fireaxe.text.indexOf('swingLeft: true') + 2;
    const ctx = cursorContextAt(fireaxe, offset);

    expect(ctx.entityIndex).toBe(0);
    expect(ctx.component).toBe('MeleeWeapon');
    expect(ctx.fieldPath).toEqual(['swingLeft']);
    expect(ctx.token).toEqual({ kind: 'key', name: 'swingLeft' });
  });

  it('reports the sibling keys of the block the caret is in', () => {
    const shallow = cursorContextAt(fireaxe, fireaxe.text.indexOf('swingLeft: true') + 2);
    expect(shallow.containerKeys).toEqual([
      'type',
      'wideAnimationRotation',
      'swingLeft',
      'attackRate',
      'damage',
      'soundHit',
    ]);

    const nested = cursorContextAt(fireaxe, fireaxe.text.indexOf('Blunt: 5') + 'Blunt: '.length);
    expect(nested.containerKeys).toEqual(['Blunt', 'Slash', 'Structural']);

    expect(cursorContextAt(fireaxe, fireaxe.text.length + 50).containerKeys).toEqual([]);
  });

  it('on the value of a top-level prototype field', () => {
    const offset = fireaxe.text.indexOf('Truly, the weapon') + 3;
    const ctx = cursorContextAt(fireaxe, offset);

    expect(ctx.entityIndex).toBe(0);
    expect(ctx.component).toBeNull();
    expect(ctx.fieldPath).toEqual(['description']);
    expect(ctx.token).toEqual({ kind: 'value' });
  });

  it('on the `parent:` key', () => {
    const offset = fireaxe.text.indexOf('parent: [BaseItem') + 2;
    const ctx = cursorContextAt(fireaxe, offset);

    expect(ctx.entityIndex).toBe(0);
    expect(ctx.component).toBeNull();
    expect(ctx.fieldPath).toEqual(['parent']);
    expect(ctx.token).toEqual({ kind: 'key', name: 'parent' });
  });

  it('keeps the full key chain on a deeply nested value', () => {
    const offset = fireaxe.text.indexOf('Blunt: 5') + 'Blunt: '.length;
    const ctx = cursorContextAt(fireaxe, offset);

    expect(ctx.component).toBe('MeleeWeapon');
    expect(ctx.fieldPath).toEqual(['damage', 'types', 'Blunt']);
    expect(ctx.token).toEqual({ kind: 'value' });
  });

  it('marks an anchored value with its anchor name (job)', () => {
    const job = parsedFixture('job.yml');
    const offset = job.text.indexOf('&icon-rsi /Textures') + '&icon-rsi /Tex'.length;
    const ctx = cursorContextAt(job, offset);

    expect(ctx.entityIndex).toBe(1);
    expect(ctx.fieldPath).toEqual(['icon', 'sprite']);
    expect(ctx.token).toEqual({ kind: 'value' });
    expect(ctx.anchor).toBe('icon-rsi');
    expect(ctx.alias).toBeUndefined();
  });

  it('marks an alias value with its target name (job)', () => {
    const job = parsedFixture('job.yml');
    const offset = job.text.indexOf('sprite: *icon-rsi') + 'sprite: *ic'.length;
    const ctx = cursorContextAt(job, offset);

    expect(ctx.entityIndex).toBe(2);
    expect(ctx.fieldPath).toEqual(['icon', 'sprite']);
    expect(ctx.alias).toBe('icon-rsi');
    expect(ctx.anchor).toBeUndefined();
  });

  it('returns an empty context for an offset outside every prototype', () => {
    const ctx = cursorContextAt(fireaxe, fireaxe.text.length + 50);

    expect(ctx.entityIndex).toBeNull();
    expect(ctx.prototypeType).toBeNull();
    expect(ctx.component).toBeNull();
    expect(ctx.fieldPath).toEqual([]);
    expect(ctx.token).toEqual({ kind: 'none' });
  });

  it('positionAt converts an offset to a 0-based line/character', () => {
    expect(positionAt(fireaxe, 0)).toEqual({ line: 0, character: 0 });
    const idOffset = fireaxe.text.indexOf('id: FireAxe');
    const pos = positionAt(fireaxe, idOffset);
    expect(pos.line).toBe(3);
    expect(pos.character).toBe(2);
  });
});

/**
 * Which sequence-valued fields are component registries is the caller's to say:
 * `ComponentRegistry` is a declared field type and this module holds no schema.
 * Told nothing, the walk knows exactly one — `components:` on the prototype map.
 */
describe('cursorContextAt — nested containers and component registries', () => {
  const nested = parsedFixture('nested_registries.yml');

  /** Caret just after `prefix`, which occurs exactly once in the fixture. */
  function caretAfter(prefix: string): number {
    const at = nested.text.indexOf(prefix);
    expect(nested.text.indexOf(prefix, at + 1)).toBe(-1);
    return at + prefix.length;
  }

  /** Reads any field named `components` as a registry, wherever it sits. */
  const anyComponentsKey = {
    isComponentRegistry: (site: { fieldPath: readonly string[] }) =>
      site.fieldPath[site.fieldPath.length - 1] === 'components',
  };

  it('walks into a list of maps, keeping the index out of the key chain', () => {
    const ctx = cursorContextAt(nested, caretAfter('  - na'));

    expect(ctx.prototypeType).toBe('inventoryTemplate');
    expect(ctx.component).toBeNull();
    expect(ctx.fieldPath).toEqual(['slots', 'name']);
    expect(ctx.token).toEqual({ kind: 'key', name: 'name' });
  });

  it('reports the `!type:` tag of every step it descended through', () => {
    const ctx = cursorContextAt(nested, caretAfter('    removeExist'));

    expect(ctx.fieldPath).toEqual(['special', 'removeExisting']);
    expect(ctx.fieldTags).toEqual(['!type:AddComponentSpecial', null]);
  });

  it('reads a registry it was not told about as an ordinary list of maps', () => {
    const ctx = cursorContextAt(nested, caretAfter('      spr'));

    expect(ctx.component).toBe('ComponentToggler');
    expect(ctx.fieldPath).toEqual(['components', 'sprite']);
  });

  it('starts a fresh chain at the component a nested registry holds', () => {
    const ctx = cursorContextAt(nested, caretAfter('      spr'), anyComponentsKey);

    expect(ctx.component).toBe('Sprite');
    expect(ctx.fieldPath).toEqual(['sprite']);
    expect(ctx.fieldTags).toEqual([null]);
    expect(ctx.containerKeys).toEqual(['type', 'sprite']);
  });

  it('reports the `type:` slot of a nested registry entry as the component-name point', () => {
    const ctx = cursorContextAt(nested, caretAfter('    - type: Spr'), anyComponentsKey);

    expect(ctx.component).toBe('Sprite');
    expect(ctx.token).toEqual({ kind: 'component-type', text: 'Sprite' });
  });

  it('asks about each sequence on the way down, from the innermost component', () => {
    const asked: unknown[] = [];
    cursorContextAt(nested, caretAfter('      spr'), {
      isComponentRegistry: (site) => {
        asked.push(site);
        return site.fieldPath[site.fieldPath.length - 1] === 'components';
      },
    });

    expect(asked).toEqual([
      { prototypeType: 'entity', component: null, fieldPath: ['components'], fieldTags: [null] },
      {
        prototypeType: 'entity',
        component: 'ComponentToggler',
        fieldPath: ['components'],
        fieldTags: [null],
      },
    ]);
  });
});

describe('cursorContextAt — on a `!type:` tag', () => {
  /** Parse inline text, failing loudly when it does not parse. */
  function parsed(text: string) {
    const result = parsePrototypeFile(text);
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result;
  }

  it('on a list item\'s tag, names the member written so far and spans the whole tag', () => {
    const claw = parsedFixture('claw.yml');
    const tagStart = claw.text.indexOf('!type:WeaponArcAttack');
    const ctx = cursorContextAt(claw, tagStart + '!type:WeaponArc'.length);

    expect(ctx.prototypeType).toBe('entityEffectAnimation');
    expect(ctx.fieldPath).toEqual(['events', '0.08']);
    expect(ctx.token).toEqual({
      kind: 'type-tag',
      text: 'WeaponArcAttack',
      range: [tagStart, tagStart + '!type:WeaponArcAttack'.length],
    });
  });

  it('on a field value\'s tag, inside a component', () => {
    const types = parsedFixture('types.yml');
    const tagStart = types.text.indexOf('!type:ToggleActionEvent');
    const ctx = cursorContextAt(types, tagStart + '!type:Tog'.length);

    expect(ctx.component).toBe('InstantAction');
    expect(ctx.fieldPath).toEqual(['event']);
    expect(ctx.token).toMatchObject({ kind: 'type-tag', text: 'ToggleActionEvent' });
  });

  it('on an empty `!type:` as the last item of a list, with nothing after it', () => {
    const text = '- type: x\n  effects:\n  - !type:Damage\n    a: 1\n  - !type:\n';
    const caret = text.lastIndexOf('!type:') + '!type:'.length;
    const ctx = cursorContextAt(parsed(text), caret);

    expect(ctx.fieldPath).toEqual(['effects']);
    expect(ctx.token).toEqual({ kind: 'type-tag', text: null, range: [caret - '!type:'.length, caret] });
  });

  it('on an empty `!type:` field value', () => {
    const text = '- type: x\n  event: !type:\n  next: 1\n';
    const ctx = cursorContextAt(parsed(text), text.indexOf('!type:') + '!type:'.length);

    expect(ctx.fieldPath).toEqual(['event']);
    expect(ctx.token).toMatchObject({ kind: 'type-tag', text: null });
  });

  it('on a tag that is still being typed', () => {
    const text = '- type: x\n  event: !ty\n';
    const ctx = cursorContextAt(parsed(text), text.indexOf('!ty') + '!ty'.length);

    expect(ctx.token).toMatchObject({ kind: 'type-tag', text: null });
  });

  it('on a tag written on its own line under the key', () => {
    const memorial = parsedFixture('memorial.yml');
    const tagStart = memorial.text.indexOf('!type:PhysShapeAabb');
    const ctx = cursorContextAt(memorial, tagStart + '!type:Phys'.length);

    expect(ctx.token).toMatchObject({ kind: 'type-tag', text: 'PhysShapeAabb' });
  });

  it('off the tag, a tagged item still reads as keys and values', () => {
    const claw = parsedFixture('claw.yml');
    const ctx = cursorContextAt(claw, claw.text.indexOf('arcWidth: 40') + 'arc'.length);

    expect(ctx.token).toEqual({ kind: 'key', name: 'arcWidth' });
    expect(ctx.fieldTags).toEqual([null, '!type:WeaponArcAttack', null]);
  });
});
