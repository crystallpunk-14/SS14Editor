import { describe, expect, it } from 'vitest';

import { completionsAt, reopensSuggestAfterDeletion } from '../../src/core/completion';
import type { ResourceEntry, ResourceTree } from '../../src/core/resource-paths';
import { schemaSnapshot } from './prototype-fixtures';

const SCHEMA = schemaSnapshot();

/**
 * An in-memory `Resources/`: directory path (relative, `/`-separated, `''` for
 * the root) to its entries, a trailing `/` marking a subdirectory. Mutable, so a
 * test can add a file between two requests. Records every directory it was asked
 * to list.
 */
function fakeTree(dirs: Record<string, string[]>): ResourceTree & { listed: string[] } {
  const listed: string[] = [];
  return {
    listed,
    listDir(relPath) {
      listed.push(relPath);
      const entries = dirs[relPath];
      return entries?.map(
        (entry): ResourceEntry =>
          entry.endsWith('/') ? { name: entry.slice(0, -1), isDirectory: true } : { name: entry, isDirectory: false },
      );
    },
  };
}

function resources(): ResourceTree & { listed: string[] } {
  return fakeTree({
    '': ['Audio/', 'Maps/', 'Textures/'],
    Maps: ['Shuttles/', 'box.yml'],
    'Maps/Shuttles': ['arrivals.yml', 'cargo.yml'],
    Audio: ['hit.ogg'],
    Textures: ['Objects/'],
  });
}

/** A component block under an entity, its last line being `line`. */
function inComponent(component: string, line: string): string {
  return `- type: entity\n  id: Foo\n  components:\n  - type: ${component}\n    ${line}\n`;
}

/** Caret right after the first occurrence of `marker` in `text`. */
function after(text: string, marker: string): number {
  const at = text.indexOf(marker);
  if (at === -1) throw new Error(`marker not found: ${marker}`);
  return at + marker.length;
}

describe('completionsAt — ResPath fields list the directory the prefix names', () => {
  it('offers the entries of the directory up to the last `/`, replacing the segment being typed', () => {
    const text = inComponent('StationArrivals', 'shuttlePath: /Maps/Shuttles/arr');
    const offset = after(text, '/Shuttles/arr');
    const tree = resources();

    const candidates = completionsAt(text, offset, SCHEMA, undefined, tree);

    expect(tree.listed).toEqual(['Maps/Shuttles']);
    const segmentStart = text.indexOf('arr');
    expect(candidates).toEqual([
      { label: 'arrivals.yml', kind: 'file', insertText: 'arrivals.yml', filterText: 'arrivals.yml', range: [segmentStart, offset] },
      { label: 'cargo.yml', kind: 'file', insertText: 'cargo.yml', filterText: 'cargo.yml', range: [segmentStart, offset] },
    ]);
  });

  it('offers subdirectories with a trailing `/`, so the path can be continued', () => {
    const text = inComponent('StationArrivals', 'shuttlePath: /Maps/');
    const offset = after(text, '/Maps/');

    const candidates = completionsAt(text, offset, SCHEMA, undefined, resources());

    expect(candidates.map((c) => [c.label, c.kind, c.insertText, c.continues])).toEqual([
      ['Shuttles', 'folder', 'Shuttles/', true],
      ['box.yml', 'file', 'box.yml', undefined],
    ]);
  });

  it('lists the `Resources/` root on an empty value slot, writing the leading `/`', () => {
    const text = inComponent('StationArrivals', 'shuttlePath: ');
    const offset = after(text, 'shuttlePath: ');
    const tree = resources();

    const candidates = completionsAt(text, offset, SCHEMA, undefined, tree);

    expect(tree.listed).toEqual(['']);
    expect(candidates.map((c) => c.insertText)).toEqual(['/Audio/', '/Maps/', '/Textures/']);
  });

  it('re-supplies the space when the caret sits right against the colon', () => {
    const text = inComponent('StationArrivals', 'shuttlePath:');
    const offset = after(text, 'shuttlePath:');

    const candidates = completionsAt(text, offset, SCHEMA, undefined, resources());

    expect(candidates.map((c) => c.insertText)).toEqual([' /Audio/', ' /Maps/', ' /Textures/']);
  });

  it('roots a first segment typed without its `/`', () => {
    const text = inComponent('StationArrivals', 'shuttlePath: Ma');
    const offset = after(text, 'shuttlePath: Ma');

    const maps = completionsAt(text, offset, SCHEMA, undefined, resources()).find((c) => c.label === 'Maps');

    expect(maps).toMatchObject({ insertText: '/Maps/', filterText: 'Maps', range: [offset - 2, offset] });
  });

  it('replaces the whole segment under the caret, not only the part before it', () => {
    const text = inComponent('StationArrivals', 'shuttlePath: /Maps/Shuttles/arrivals.yml');
    const offset = after(text, '/Shuttles/arr');

    const [first] = completionsAt(text, offset, SCHEMA, undefined, resources());

    expect(first.range).toEqual([text.indexOf('arrivals'), after(text, 'arrivals.yml')]);
  });

  it('reads the disk on every request: a file added in between is offered next time', () => {
    const dirs: Record<string, string[]> = { Maps: ['box.yml'] };
    const tree = fakeTree(dirs);
    const text = inComponent('StationArrivals', 'shuttlePath: /Maps/');
    const offset = after(text, '/Maps/');

    expect(completionsAt(text, offset, SCHEMA, undefined, tree).map((c) => c.label)).toEqual(['box.yml']);
    dirs.Maps = ['box.yml', 'new.yml'];
    expect(completionsAt(text, offset, SCHEMA, undefined, tree).map((c) => c.label)).toEqual(['box.yml', 'new.yml']);
  });

  it('works on a prototype field typed `ResPath`', () => {
    const text = '- type: gameMap\n  id: Foo\n  mapPath: /Maps/\n';
    const offset = after(text, '/Maps/');

    expect(completionsAt(text, offset, SCHEMA, undefined, resources()).map((c) => c.label)).toEqual([
      'Shuttles',
      'box.yml',
    ]);
  });

  it('works on an item of a `List<ResPath>`', () => {
    const text = inComponent('CEStationZLevels', 'mapsBelow:\n    - /Maps/Shuttles/');
    const offset = after(text, '- /Maps/Shuttles/');

    expect(completionsAt(text, offset, SCHEMA, undefined, resources()).map((c) => c.label)).toEqual([
      'arrivals.yml',
      'cargo.yml',
    ]);
  });

  it('works on an item of a flow-style list, stopping the segment at the bracket', () => {
    const text = inComponent('CEStationZLevels', 'mapsBelow: [/Maps/box.yml,/Maps/b]');
    const offset = after(text, ',/Maps/b');

    const candidates = completionsAt(text, offset, SCHEMA, undefined, resources());

    expect(candidates.map((c) => c.label)).toEqual(['Shuttles', 'box.yml']);
    expect(candidates[0].range).toEqual([offset - 1, offset]);
  });

  it('reopens the list after a deletion inside a path', () => {
    const text = inComponent('StationArrivals', 'shuttlePath: /Maps/Shuttles/ar');
    const offset = after(text, '/Shuttles/ar');

    expect(reopensSuggestAfterDeletion(text, offset, SCHEMA, undefined, resources())).toBe(true);
  });
});

describe('completionsAt — ResPath dispatch is by `fieldKind` alone', () => {
  it.each([
    ['`sprite:` of Sprite (a string)', inComponent('Sprite', 'sprite: /Textures/')],
    ['`state:` of Sprite (a string)', inComponent('Sprite', 'state: /Textures/')],
    ['`path:` inside an untagged SoundSpecifier', inComponent('MeleeWeapon', 'soundHit:\n      path: /Audio/')],
  ])('offers no paths on %s', (_, text) => {
    const tree = resources();
    const offset = text.lastIndexOf('/') + 1;

    expect(completionsAt(text, offset, SCHEMA, undefined, tree)).toEqual([]);
    expect(tree.listed).toEqual([]);
  });

  it.each([
    [
      '`path:` inside a `!type:SoundPathSpecifier`',
      inComponent('MeleeWeapon', 'soundHit: !type:SoundPathSpecifier\n      path: /Audio/'),
      'Audio',
    ],
    [
      '`sprite:` inside a `!type:Rsi` SpriteSpecifier',
      inComponent('GrapplingGun', 'ropeSprite: !type:Rsi\n      sprite: /Textures/'),
      'Textures',
    ],
  ])('offers paths on %s, whose tag names a member declaring a ResPath', (_, text, dir) => {
    const tree = resources();
    const offset = text.lastIndexOf('/') + 1;

    expect(completionsAt(text, offset, SCHEMA, undefined, tree)).not.toEqual([]);
    expect(tree.listed).toEqual([dir]);
  });

  it('offers the root on an empty `path:` under `!type:SoundPathSpecifier`', () => {
    const text = inComponent('SoundOnGather', 'sound: !type:SoundPathSpecifier\n      path: ');
    const offset = after(text, 'path: ');

    expect(completionsAt(text, offset, SCHEMA, undefined, resources()).map((c) => c.insertText)).toEqual([
      '/Audio/',
      '/Maps/',
      '/Textures/',
    ]);
  });

  it('offers nothing without a resource tree', () => {
    const text = inComponent('StationArrivals', 'shuttlePath: /Maps/');

    expect(completionsAt(text, after(text, '/Maps/'), SCHEMA)).toEqual([]);
  });
});

describe('completionsAt — a bad ResPath prefix gives an empty list, never an error', () => {
  it.each([
    ['a directory that does not exist', '/Nope/'],
    ['a file used as a directory', '/Maps/box.yml/'],
    ['a parent step', '/Maps/../'],
    ['a current-directory step', '/./Maps/'],
    ['an empty segment', '/Maps//'],
    ['a backslash', '/Maps\\Shuttles/'],
  ])('%s', (_, prefix) => {
    const text = inComponent('StationArrivals', `shuttlePath: ${prefix}`);
    const offset = after(text, prefix);

    expect(completionsAt(text, offset, SCHEMA, undefined, resources())).toEqual([]);
  });

  it('a listing that throws', () => {
    const text = inComponent('StationArrivals', 'shuttlePath: /Maps/');
    const throwing: ResourceTree = {
      listDir: () => {
        throw new Error('EACCES');
      },
    };

    expect(completionsAt(text, after(text, '/Maps/'), SCHEMA, undefined, throwing)).toEqual([]);
  });
});
