import { describe, expect, it } from 'vitest';

import { foldedText, locHoverMarkdown, locIdAt, locIdSpansIn } from '../../src/core/loc-id';
import { collectLocRecords, declarationSpan, LocalizationIndex, localeOf } from '../../src/core/localization-index';
import { schemaSnapshot } from './prototype-fixtures';

const SCHEMA = schemaSnapshot();

function indexOf(files: Record<string, string>): LocalizationIndex {
  const index = new LocalizationIndex();
  index.replaceAll(Object.entries(files).flatMap(([path, text]) => collectLocRecords(text, path)));
  return index;
}

const EN = 'Resources/Locale/en-US/skills.ftl';
const RU = 'Resources/Locale/ru-RU/skills.ftl';

describe('localeOf', () => {
  it('reads the locale folder of the fork and the engine roots', () => {
    expect(localeOf('Resources/Locale/ru-RU/_CE/a.ftl')).toBe('ru-RU');
    expect(localeOf('RobustToolbox/Resources/Locale/en-US/a.ftl')).toBe('en-US');
    expect(localeOf('Resources/Prototypes/a.yml')).toBeNull();
    expect(localeOf('Resources/Locale/a.ftl')).toBeNull();
  });
});

describe('LocalizationIndex', () => {
  const index = indexOf({
    [EN]: 'skill-name = Swordsmanship\n    .desc = Fight with { -blade }s.\n-blade = sword\nonly-en = English only\n',
    [RU]: 'skill-name = Фехтование\n-blade = меч\n',
    'Resources/Locale/nl-NL/skills.ftl': 'skill-name = Zwaardvechten\n',
  });

  it('is not ready until loaded', () => {
    const empty = new LocalizationIndex();
    expect(empty.ready).toBe(false);
    expect(empty.has('skill-name')).toBe(false);
  });

  it('orders declarations display locale first, then en-US, then the rest', () => {
    expect(index.declarations('skill-name', 'ru-RU').map((record) => record.locale)).toEqual(['ru-RU', 'en-US', 'nl-NL']);
    expect(index.declarations('skill-name').map((record) => record.locale)).toEqual(['en-US', 'nl-NL', 'ru-RU']);
    expect(index.declarations('skill-name', 'ru-RU')[0]).toMatchObject({ filePath: RU, line: 0 });
  });

  it('previews in the display locale, falling back to en-US', () => {
    expect(index.preview('skill-name', 'ru-RU')).toBe('Фехтование');
    expect(index.preview('only-en', 'ru-RU')).toBe('English only');
    expect(index.preview('missing', 'ru-RU')).toBeNull();
  });

  it('does not fall back to a third locale', () => {
    const nlOnly = indexOf({ 'Resources/Locale/nl-NL/a.ftl': 'x = nl\n' });
    expect(nlOnly.preview('x', 'ru-RU')).toBeNull();
    expect(nlOnly.has('x')).toBe(true);
  });

  it('reads attributes and resolves terms within the locale', () => {
    expect(index.preview('skill-name.desc')).toBe('Fight with swords.');
    expect(index.has('skill-name.nope')).toBe(false);
    expect(index.has('skill-name.toString')).toBe(false);
  });

  it('points a declaration at the id, or at the attribute of msg.attr', () => {
    const [record] = index.declarations('skill-name.desc');
    expect(declarationSpan(record, 'skill-name')).toEqual({ line: 0, column: 0, length: 10 });
    expect(declarationSpan(record, 'skill-name.desc')).toEqual({ line: 1, column: 4, length: 5 });
  });

  it('lists one translation per locale', () => {
    expect(index.translations('skill-name', 'ru-RU').map((t) => [t.locale, t.text])).toEqual([
      ['ru-RU', 'Фехтование'],
      ['en-US', 'Swordsmanship'],
      ['nl-NL', 'Zwaardvechten'],
    ]);
  });

  it('patches one file in place', () => {
    const live = indexOf({ [EN]: 'a = one\n' });
    expect(live.updateFile(EN, collectLocRecords('a = one\n', EN))).toBe(false);
    expect(live.updateFile(EN, collectLocRecords('a = two\nb = three\n', EN))).toBe(true);
    expect(live.preview('a')).toBe('two');
    expect(live.updateFile(EN, [])).toBe(true);
    expect(live.has('a')).toBe(false);
  });
});

describe('LocId spans', () => {
  const known = new Set(['skill-name', 'wires-board', 'popup-a', 'popup-b', 'rattle-x']);
  const isKnown = (key: string) => known.has(key);

  const TEXT = [
    '- type: skill',
    '  id: Fencing',
    '  name: skill-name',
    '  desc: "rattle-x"',
    '- type: entity',
    '  id: Board',
    '  name: skill-name',
    '  components:',
    '  - type: Wires',
    '    boardName: wires-board',
    '    layoutId: skill-name',
    '  - type: DamageRandomPopup',
    '    popups:',
    '    - popup-a',
    '    - popup-b',
    '  - type: RattleOnTrigger',
    '    messages:',
    '      Critical: rattle-x',
    '',
  ].join('\n');

  it('finds every LocId-typed value a known key sits in', () => {
    const spans = locIdSpansIn(TEXT, SCHEMA, isKnown);
    expect(spans.map((span) => span.key)).toEqual(['skill-name', 'rattle-x', 'wires-board', 'popup-a', 'popup-b', 'rattle-x']);
    const quoted = spans[1];
    expect(TEXT.slice(quoted.range[0], quoted.range[1])).toBe('rattle-x');
    // A fold hides the YAML quotes too, or they would wrap its own: `""text""`.
    expect(TEXT.slice(quoted.outer[0], quoted.outer[1])).toBe('"rattle-x"');
    expect(locIdAt(TEXT, quoted.outer[0], SCHEMA)?.key).toBe('rattle-x');
  });

  it('skips an entity name, which is a plain string, and a non-LocId field', () => {
    const offsets = locIdSpansIn(TEXT, SCHEMA, isKnown).map((span) => span.range[0]);
    expect(offsets).not.toContain(TEXT.indexOf('skill-name', TEXT.indexOf('id: Board')));
    expect(offsets).not.toContain(TEXT.indexOf('skill-name', TEXT.indexOf('layoutId')));
  });

  it('answers the value under the caret, at either end too', () => {
    const start = TEXT.indexOf('wires-board');
    expect(locIdAt(TEXT, start, SCHEMA)).toEqual({ range: [start, start + 11], outer: [start, start + 11], key: 'wires-board' });
    expect(locIdAt(TEXT, start + 11, SCHEMA)?.key).toBe('wires-board');
    expect(locIdAt(TEXT, TEXT.indexOf('boardName'), SCHEMA)).toBeNull();
    expect(locIdAt(TEXT, TEXT.indexOf('Board\n'), SCHEMA)).toBeNull();
  });

  it('returns nothing for a file that does not parse', () => {
    expect(locIdSpansIn('- type: skill\n  name: [oops\n', SCHEMA, isKnown)).toEqual([]);
  });
});

describe('presentation', () => {
  it('quotes and cuts a folded preview', () => {
    expect(foldedText('short')).toBe('"short"');
    const folded = foldedText('x'.repeat(100));
    expect(folded.length).toBe(62);
    expect(folded.endsWith('…"')).toBe(true);
  });

  it('lists each locale with a link in the hover', () => {
    const index = indexOf({ [EN]: 'k = Hello *world*\n', [RU]: 'k = Привет\n' });
    const markdown = locHoverMarkdown('k', index.translations('k', 'ru-RU'), (record, line) => `file:///${record.filePath}#L${line + 1}`);
    expect(markdown).toContain('**ru-RU**: Привет — [skills\\.ftl:1](file:///Resources/Locale/ru-RU/skills.ftl#L1)');
    expect(markdown).toContain('**en-US**: Hello \\*world\\*');
    expect(locHoverMarkdown('k', [], () => '')).toContain('No translation found');
    const plain = locHoverMarkdown('k', index.translations('k', 'ru-RU'));
    expect(plain).not.toContain('](');
    expect(plain).toMatch(/\.ftl:\d+/);
  });
});
