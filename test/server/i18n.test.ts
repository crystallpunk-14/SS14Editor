import { describe, expect, it } from 'vitest';

import { interpretSchemaResult, type ForkProblemCode, type PrototypeDiagnostic } from '../../src/core';
import { localeOf, messagesFor } from '../../src/server/i18n';

/**
 * The server's message catalog. English must be the core's text unchanged, so
 * VS Code and the server never word the same problem differently; Russian is
 * built from codes and data, so every code needs its own text.
 */
const EN = messagesFor('en');
const RU = messagesFor('ru');

const FORK_CODES: ForkProblemCode[] = [
  'no-robusttoolbox-submodule',
  'no-content-server',
  'no-content-client',
  'no-resources-prototypes',
  'dlls-not-found',
];

describe('localeOf', () => {
  it('takes `ru` and falls back to English for anything else', () => {
    expect(localeOf('ru')).toBe('ru');
    for (const other of ['en', 'de', undefined, 42]) expect(localeOf(other)).toBe('en');
  });
});

describe('messages', () => {
  it('passes the core text through in English', () => {
    const status = { recognized: false, code: 'no-content-server', message: 'core text' } as const;
    expect(EN.forkProblem(status)).toBe('core text');
  });

  it('has a Russian text of its own for every fork problem', () => {
    const texts = FORK_CODES.map((code) => RU.forkProblem({ recognized: false, code, message: 'x' }));
    expect(new Set(texts).size).toBe(FORK_CODES.length);
    for (const text of texts) expect(text).toMatch(/[а-я]/);
  });

  it('keeps .NET stderr as it is inside a Russian schema problem', () => {
    const status = interpretSchemaResult({
      run: { kind: 'exited', code: 1, stderr: 'Unhandled exception: boom' },
      parse: undefined,
      sidecarFingerprint: undefined,
      expectedVersion: 1,
    });
    if (status.state === 'loaded') throw new Error('expected a failure');
    expect(RU.schemaProblem(status)).toBe('Не удалось извлечь схему:\nUnhandled exception: boom');
  });

  it('builds Russian diagnostics from the fields, not from the English message', () => {
    const base = { range: [0, 1] as const, message: 'english' };
    const cases: Array<[PrototypeDiagnostic, string]> = [
      [{ ...base, code: 'unknown-component', value: 'Itme' }, 'Неизвестный компонент «Itme».'],
      [{ ...base, code: 'unknown-prototype', value: 'BaseItme', kind: 'entity' }, 'Нет прототипа entity с id «BaseItme».'],
      [{ ...base, code: 'invalid-enum-value', value: 'Flying', choices: ['OnGround', 'InAir'] }, '«Flying» — не одно из значений: OnGround, InAir.'],
    ];
    for (const [problem, text] of cases) {
      expect(RU.diagnostic(problem)).toBe(text);
      expect(EN.diagnostic(problem)).toBe('english');
    }
  });

  it('renames the index failure prefix, keeping the reason', () => {
    expect(RU.indexFailed('Prototype index failed: the worker exited (code 1)')).toBe(
      'Не удалось построить индекс прототипов: the worker exited (code 1)',
    );
  });
});
