import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXTENSION_ID, PUBLISHER, QUALIFIED_EXTENSION_ID } from '../../src/core';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as {
  name: string;
  publisher: string;
};

/**
 * The host looks its own manifest up by {@link QUALIFIED_EXTENSION_ID}, and
 * VS Code builds that id from `package.json`. A mismatch is silent at runtime
 * (the lookup just returns `undefined`), so pin the two together here.
 */
describe('extension id', () => {
  it('matches the publisher and name in package.json', () => {
    expect(PUBLISHER).toBe(manifest.publisher);
    expect(EXTENSION_ID).toBe(manifest.name);
    expect(QUALIFIED_EXTENSION_ID).toBe(`${manifest.publisher}.${manifest.name}`);
  });
});
