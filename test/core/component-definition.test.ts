import { describe, expect, it } from 'vitest';

import {
  baseClassOf,
  ClassLocator,
  classDeclarationsIn,
  docSummaryBefore,
  memberOffsetIn,
  type CsSourceTree,
} from '../../src/core/class-location';
import { classDefinitionAt } from '../../src/core/definition';
import { parsedFixture, schemaSnapshot } from './prototype-fixtures';

/**
 * Go-to-definition from a component name or a `!type:` tag to its C# class
 * (issue #31). The
 * locator runs over a fake fork's git-tracked `.cs` files; the cursor half reads
 * the committed crystall-edge schema snapshot for the component's class name.
 */
const SCHEMA = schemaSnapshot();

/** An in-memory {@link CsSourceTree}; counts reads so the fast path is observable. */
function tree(files: Record<string, string>): CsSourceTree & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    listFiles: () => Promise.resolve(Object.keys(files)),
    readFile: (path) => {
      reads.push(path);
      return Promise.resolve(files[path]);
    },
  };
}

/** Line (0-based) of `offset` in `text`, for "lands on the declaration line" assertions. */
function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length - 1;
}

describe('classDeclarationsIn — class declarations of one C# file', () => {
  it('reads a class under a file-scoped namespace, at the offset of its name', () => {
    const text = [
      'using Robust.Shared.GameObjects;',
      '',
      'namespace Content.Shared.Damage.Components;',
      '',
      '[RegisterComponent]',
      'public sealed partial class DamageableComponent : Component',
      '{',
      '}',
    ].join('\n');

    const [decl] = classDeclarationsIn(text);
    expect(decl).toEqual({
      name: 'DamageableComponent',
      namespace: 'Content.Shared.Damage.Components',
      offset: text.indexOf('DamageableComponent'),
    });
  });

  it('reads nested block namespaces and drops them once their block closes', () => {
    const text = [
      'namespace Content.Server',
      '{',
      '    namespace Atmos',
      '    {',
      '        public sealed class InnerComponent {}',
      '    }',
      '    public sealed class OuterComponent {}',
      '}',
      'public sealed class GlobalComponent {}',
    ].join('\n');

    expect(classDeclarationsIn(text).map((d) => [d.name, d.namespace])).toEqual([
      ['InnerComponent', 'Content.Server.Atmos'],
      ['OuterComponent', 'Content.Server'],
      ['GlobalComponent', null],
    ]);
  });

  it('ignores `class X` inside comments, strings and char literals', () => {
    const text = [
      'namespace Content.Shared.Foo;',
      '// public sealed class FakeComponent : Component',
      '/* class FakeComponent',
      '   still a comment */',
      '/// <summary>class FakeComponent</summary>',
      'public static class Strings',
      '{',
      '    const string A = "class FakeComponent";',
      '    const string B = @"multi',
      'class FakeComponent ""quoted""";',
      '    const string C = $"{Loc.GetString("class FakeComponent")} class FakeComponent {{ }}";',
      '    const string D = """',
      '        class FakeComponent "quoted"',
      '        """;',
      "    const char E = '\"';",
      '    const string F = "escaped \\" class FakeComponent";',
      '}',
      'public sealed class RealComponent {}',
    ].join('\n');

    expect(classDeclarationsIn(text).map((d) => d.name)).toEqual(['Strings', 'RealComponent']);
  });

  it('does not read a `class` generic constraint as a declaration', () => {
    const text = [
      'namespace Content.Shared.Foo;',
      'public static class Ext',
      '{',
      '    public static T Get<T, U>() where T : class where U : class',
      '    {',
      '        return default!;',
      '    }',
      '}',
    ].join('\n');

    expect(classDeclarationsIn(text).map((d) => d.name)).toEqual(['Ext']);
  });

  it('reports `record class` and nested classes, and keeps braces inside strings out of the namespace count', () => {
    const text = [
      'namespace Content.Shared.Foo',
      '{',
      '    public sealed class Outer',
      '    {',
      '        const string S = "}}}";',
      '        public sealed record class NestedComponent;',
      '    }',
      '}',
    ].join('\n');

    expect(classDeclarationsIn(text).map((d) => [d.name, d.namespace])).toEqual([
      ['Outer', 'Content.Shared.Foo'],
      ['NestedComponent', 'Content.Shared.Foo'],
    ]);
  });
});

describe('ClassLocator — where a component class is declared in the fork', () => {
  const SERVER = 'Content.Server/Atmos/Components/FlammableComponent.cs';
  const SERVER_TEXT = [
    'namespace Content.Server.Atmos.Components;',
    '',
    '[RegisterComponent]',
    'public sealed partial class FlammableComponent : Component {}',
  ].join('\n');
  const CLIENT = 'Content.Client/Sprite/RandomSpriteComponent.cs';
  const CLIENT_TEXT = [
    'namespace Content.Client.Sprite;',
    '[RegisterComponent]',
    'public sealed partial class RandomSpriteComponent : Component {}',
  ].join('\n');
  const ENGINE = 'RobustToolbox/Robust.Shared/GameObjects/Components/Transform/TransformComponent.cs';
  const ENGINE_TEXT = [
    'namespace Robust.Shared.GameObjects',
    '{',
    '    public sealed partial class TransformComponent : Component {}',
    '}',
  ].join('\n');
  /** A component living in a file not named after it — only the full scan finds it. */
  const ODD = 'Content.Shared/Misc/Components.cs';
  const ODD_TEXT = [
    'namespace Content.Shared.Misc;',
    '// class HiddenComponent in a comment first',
    'public sealed partial class HiddenComponent : Component {}',
  ].join('\n');
  /** Same short name as the server one, different namespace. */
  const DECOY = 'Content.IntegrationTests/Tests/FlammableComponent.cs';
  const DECOY_TEXT = 'namespace Content.IntegrationTests.Tests;\npublic sealed class FlammableComponent {}';
  /** Outside the C# project roots — never consulted. */
  const OUTSIDE = 'Tools/Scratch/HiddenComponent.cs';

  const FILES = {
    [SERVER]: SERVER_TEXT,
    [CLIENT]: CLIENT_TEXT,
    [ENGINE]: ENGINE_TEXT,
    [ODD]: ODD_TEXT,
    [DECOY]: DECOY_TEXT,
    [OUTSIDE]: 'namespace Content.Shared.Misc;\npublic sealed class HiddenComponent {}',
  };

  it('finds a Content.Server component at its declaration line, skipping a same-named class in another namespace', async () => {
    const locator = new ClassLocator(tree(FILES));

    const found = await locator.locate('Content.Server.Atmos.Components.FlammableComponent');

    expect(found).toEqual([{ filePath: SERVER, offset: SERVER_TEXT.indexOf('FlammableComponent'), name: 'FlammableComponent' }]);
    expect(lineOf(SERVER_TEXT, found[0].offset)).toBe(3);
  });

  it('finds a Content.Client component the same way', async () => {
    const found = await new ClassLocator(tree(FILES)).locate('Content.Client.Sprite.RandomSpriteComponent');

    expect(found).toEqual([{ filePath: CLIENT, offset: CLIENT_TEXT.indexOf('RandomSpriteComponent'), name: 'RandomSpriteComponent' }]);
  });

  it('finds an engine component in the RobustToolbox submodule', async () => {
    const found = await new ClassLocator(tree(FILES)).locate('Robust.Shared.GameObjects.TransformComponent');

    expect(found).toEqual([{ filePath: ENGINE, offset: ENGINE_TEXT.indexOf('TransformComponent'), name: 'TransformComponent' }]);
  });

  it('reads only the file named after the class when that is where it lives', async () => {
    const source = tree(FILES);

    await new ClassLocator(source).locate('Content.Client.Sprite.RandomSpriteComponent');

    expect(source.reads).toEqual([CLIENT]);
  });

  it('falls back to scanning every file for a class not in a file of its own name, ignoring files outside the C# projects', async () => {
    const source = tree(FILES);
    const locator = new ClassLocator(source);

    const found = await locator.locate('Content.Shared.Misc.HiddenComponent');

    expect(found).toEqual([{ filePath: ODD, offset: ODD_TEXT.lastIndexOf('HiddenComponent'), name: 'HiddenComponent' }]);
    expect(source.reads).not.toContain(OUTSIDE);

    // The scan is kept: a second miss reads nothing new.
    const before = source.reads.length;
    expect(await locator.locate('Content.Shared.Misc.NoSuchComponent')).toEqual([]);
    expect(source.reads.length).toBe(before);
  });

  it('returns every part of a partial class', async () => {
    const shared = 'Content.Shared/Foo/FooComponent.cs';
    const server = 'Content.Server/Foo/FooComponent.Server.cs';
    const source = tree({
      [shared]: 'namespace Content.Shared.Foo;\npublic sealed partial class FooComponent {}',
      [server]: 'namespace Content.Shared.Foo;\npublic sealed partial class FooComponent {}',
    });

    const found = await new ClassLocator(source).locate('Content.Shared.Foo.FooComponent');

    expect(found.map((l) => l.filePath)).toEqual([shared, server]);
  });

  it('returns nothing for an unknown class, without throwing', async () => {
    expect(await new ClassLocator(tree(FILES)).locate('Content.Shared.Nope.NopeComponent')).toEqual([]);
  });

  it('returns nothing when the file list is unavailable (git missing, not a repo)', async () => {
    const source: CsSourceTree = {
      listFiles: () => Promise.resolve(undefined),
      readFile: () => Promise.resolve(undefined),
    };

    expect(await new ClassLocator(source).locate('Content.Server.Atmos.Components.FlammableComponent')).toEqual([]);
  });

  it('asks for the file list again after a failed listing, and still scans once it succeeds', async () => {
    const ok = tree(FILES);
    let listed = 0;
    const source: CsSourceTree = {
      listFiles: () => (listed++ === 0 ? Promise.resolve(undefined) : ok.listFiles()),
      readFile: ok.readFile,
    };
    const locator = new ClassLocator(source);

    expect(await locator.locate('Content.Shared.Misc.HiddenComponent')).toEqual([]);
    expect(await locator.locate('Content.Shared.Misc.HiddenComponent')).toEqual([
      { filePath: ODD, offset: ODD_TEXT.lastIndexOf('HiddenComponent'), name: 'HiddenComponent' },
    ]);
  });

  it('reports offsets into the BOM-stripped text', async () => {
    const path = 'Content.Shared/Bom/BomComponent.cs';
    const text = 'namespace Content.Shared.Bom;\npublic sealed class BomComponent {}';

    const source = tree({ [path]: String.fromCharCode(0xfeff) + text });

    const found = await new ClassLocator(source).locate('Content.Shared.Bom.BomComponent');

    expect(found).toEqual([{ filePath: path, offset: text.indexOf('BomComponent'), name: 'BomComponent' }]);
  });
});

describe('ClassLocator — nested classes', () => {
  it('finds a nested class in the file named after its outermost class', async () => {
    const path = 'Content.Shared/Weapons/Ranged/Systems/SharedGunSystem.cs';
    const text = [
      'namespace Content.Shared.Weapons.Ranged.Systems;',
      'public abstract partial class SharedGunSystem : EntitySystem',
      '{',
      '}',
      'public sealed partial class CycleModeEvent : InstantActionEvent {}',
    ].join('\n');
    const source = tree({ [path]: text, 'Content.Shared/Other.cs': 'namespace Content.Shared;' });

    const found = await new ClassLocator(source).locate('Content.Shared.Weapons.Ranged.Systems.SharedGunSystem+CycleModeEvent');

    expect(found).toEqual([{ filePath: path, offset: text.indexOf('CycleModeEvent'), name: 'CycleModeEvent' }]);
    expect(source.reads).toEqual([path]);
  });
});

describe('classDefinitionAt — a `!type:` tag under the caret', () => {
  const claw = parsedFixture('claw.yml');
  const types = parsedFixture('types.yml');

  /** `[start, end)` of the member name in the first `!type:<name>` of `text`. */
  function nameSpan(text: string, name: string): [number, number] {
    const start = text.indexOf(`!type:${name}`) + '!type:'.length;
    return [start, start + name.length];
  }

  it("names the union member a list item's tag picks, spanning the name only", () => {
    const [start, end] = nameSpan(claw.text, 'WeaponArcAttack');

    expect(classDefinitionAt(claw.text, start + 3, SCHEMA)).toMatchObject({
      origin: [start, end],
      className: 'Content.Shared._CE.EntityEffect.Effects.WeaponArcAttack',
    });
  });

  it('resolves with the caret on the `!type:` prefix too', () => {
    const tag = claw.text.indexOf('!type:WeaponArcAttack');

    expect(classDefinitionAt(claw.text, tag + 1, SCHEMA)?.className).toBe(
      'Content.Shared._CE.EntityEffect.Effects.WeaponArcAttack',
    );
  });

  it("names the member an `event:` field's tag picks", () => {
    const [start] = nameSpan(types.text, 'ToggleActionEvent');

    expect(classDefinitionAt(types.text, start, SCHEMA)?.className).toBe('Content.Shared.Toggleable.ToggleActionEvent');
  });

  it('has no target for a tag naming no member of the declared union', () => {
    const at = claw.text.indexOf('!type:WeaponArcAttack');
    const text = claw.text.slice(0, at) + '!type:NoSuchEffect' + claw.text.slice(at + '!type:WeaponArcAttack'.length);

    expect(classDefinitionAt(text, at + '!type:No'.length, SCHEMA)).toBeNull();
  });

  it('has no target for an empty tag', () => {
    const at = claw.text.indexOf('!type:WeaponArcAttack');
    const text = claw.text.slice(0, at) + '!type:' + claw.text.slice(at + '!type:WeaponArcAttack'.length);

    expect(classDefinitionAt(text, at + '!type:'.length, SCHEMA)).toBeNull();
  });
});

describe('classDefinitionAt — the component name under the caret', () => {
  const TEXT = [
    '- type: entity',
    '  id: Thing',
    '  components:',
    '  - type: Damageable',
    '  - type: Transform',
    '  - type: NoSuchComponentAnywhere',
    '  - type: Sprite',
    '    state: icon',
    '',
  ].join('\n');

  it('names the class of a content component and spans the written name', () => {
    const offset = TEXT.indexOf('Damageable') + 3;

    expect(classDefinitionAt(TEXT, offset, SCHEMA)).toMatchObject({
      origin: [TEXT.indexOf('Damageable'), TEXT.indexOf('Damageable') + 'Damageable'.length],
      className: SCHEMA.components.Damageable.className,
    });
  });

  it('names the class of an engine component', () => {
    const offset = TEXT.indexOf('Transform');

    expect(classDefinitionAt(TEXT, offset, SCHEMA)?.className).toBe('Robust.Shared.GameObjects.TransformComponent');
  });

  it('has no target for a component the schema does not know', () => {
    const offset = TEXT.indexOf('NoSuchComponentAnywhere') + 2;

    expect(classDefinitionAt(TEXT, offset, SCHEMA)).toBeNull();
  });

  it('has no target off the component name', () => {
    expect(classDefinitionAt(TEXT, TEXT.indexOf('icon'), SCHEMA)).toBeNull();
    expect(classDefinitionAt(TEXT, TEXT.indexOf('entity'), SCHEMA)).toBeNull();
  });
});

describe('docSummaryBefore — the /// summary over a declaration', () => {
  it('reads the summary over attributes, tags dropped and crefs shortened', () => {
    const text = [
      '/// <summary>',
      '/// Protects from <see cref="T:Content.Shared.Explosion.ExplosionPrototype"/>;',
      '/// use <c>worn: false</c> to skip the wearer.',
      '/// </summary>',
      '[RegisterComponent, NetworkedComponent]',
      '[Access(typeof(Foo),',
      '    Other = AccessPermissions.ReadWrite)]',
      'public sealed partial class ExplosionResistanceComponent : Component',
    ].join('\n');

    expect(docSummaryBefore(text, text.indexOf('ExplosionResistanceComponent'))).toBe(
      'Protects from ExplosionPrototype; use worn: false to skip the wearer.',
    );
  });

  it('is null without a doc comment, or with only <inheritdoc/>', () => {
    const plain = '// not a doc\n[DataField]\npublic int Count;';
    const inherited = '/// <inheritdoc/>\npublic int Count;';
    expect(docSummaryBefore(plain, plain.indexOf('Count'))).toBeNull();
    expect(docSummaryBefore(inherited, inherited.indexOf('Count'))).toBeNull();
  });
});

describe('memberOffsetIn / baseClassOf — a field in a class body', () => {
  const TEXT = [
    'public sealed partial class ClothingComponent : BaseClothingComponent<int>, IComponent',
    '{',
    '    [DataField]',
    '    public SoundSpecifier? EquipSound = new SoundPathSpecifier("/x.ogg");',
    '    [DataField("slots")] public SlotFlags Slots { get; set; } = SlotFlags.NONE;',
    '    public int[] Ids;',
    '    public void Run() { var Local = 1; return Hidden; }',
    '}',
  ].join('\n');
  const classOffset = TEXT.indexOf('ClothingComponent');

  it('finds fields and properties at the body’s own depth', () => {
    expect(memberOffsetIn(TEXT, classOffset, 'EquipSound')).toBe(TEXT.indexOf('EquipSound'));
    expect(memberOffsetIn(TEXT, classOffset, 'Slots')).toBe(TEXT.indexOf('Slots {'));
    expect(memberOffsetIn(TEXT, classOffset, 'Ids')).toBe(TEXT.indexOf('Ids'));
  });

  it('does not take a local or a statement inside a method for a field', () => {
    expect(memberOffsetIn(TEXT, classOffset, 'Local')).toBeNull();
    expect(memberOffsetIn(TEXT, classOffset, 'Hidden')).toBeNull();
  });

  it('names the base class, generics dropped, and none for interfaces only', () => {
    expect(baseClassOf(TEXT, classOffset)).toBe('BaseClothingComponent');
    const onlyInterfaces = 'public sealed class A : IFoo, IBar {}';
    expect(baseClassOf(onlyInterfaces, onlyInterfaces.indexOf('A '))).toBeNull();
  });
});

describe('ClassLocator — members and summaries from source', () => {
  const files = {
    'Content.Shared/Clothing/ClothingComponent.cs': [
      'namespace Content.Shared.Clothing;',
      '/// <summary>Handles entities which can be equipped.</summary>',
      'public sealed partial class ClothingComponent : BaseClothing',
      '{',
      '    /// <summary>Slots it fits.</summary>',
      '    [DataField] public string Slots = "";',
      '}',
    ].join('\n'),
    'Content.Shared/Clothing/BaseClothing.cs': [
      'namespace Content.Shared.Clothing.Base;',
      'public abstract partial class BaseClothing : Component',
      '{',
      '    /// <summary>Worn sprite.</summary>',
      '    [DataField] public string Sprite = "";',
      '}',
    ].join('\n'),
  };

  it('reads a class summary', async () => {
    const locator = new ClassLocator(tree(files));
    expect(await locator.classSummary('Content.Shared.Clothing.ClothingComponent')).toBe(
      'Handles entities which can be equipped.',
    );
  });

  it('finds a field on the class, and one inherited from a base in another namespace', async () => {
    const locator = new ClassLocator(tree(files));
    expect(await locator.locateMember('Content.Shared.Clothing.ClothingComponent', 'Slots')).toEqual([
      {
        filePath: 'Content.Shared/Clothing/ClothingComponent.cs',
        offset: files['Content.Shared/Clothing/ClothingComponent.cs'].indexOf('Slots ='),
        name: 'Slots',
        summary: 'Slots it fits.',
      },
    ]);
    const [inherited] = await locator.locateMember('Content.Shared.Clothing.ClothingComponent', 'Sprite');
    expect(inherited).toMatchObject({ filePath: 'Content.Shared/Clothing/BaseClothing.cs', summary: 'Worn sprite.' });
    expect(await locator.locateMember('Content.Shared.Clothing.ClothingComponent', 'Nope')).toEqual([]);
  });
});
