import * as assert from 'node:assert';

import * as vscode from 'vscode';

import { QUALIFIED_EXTENSION_ID } from '../../src/core';

suite('activation smoke', () => {
  test('the extension is installed in the test host', () => {
    assert.ok(
      vscode.extensions.getExtension(QUALIFIED_EXTENSION_ID),
      `extension ${QUALIFIED_EXTENSION_ID} not found`,
    );
  });

  test('the extension activates without throwing', async () => {
    const ext = vscode.extensions.getExtension(QUALIFIED_EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('the "SS14: Rebuild schema" command is contributed and registered', async () => {
    const ext = vscode.extensions.getExtension(QUALIFIED_EXTENSION_ID);
    const commands = (ext?.packageJSON?.contributes?.commands ?? []) as Array<{
      command: string;
      title: string;
      category?: string;
    }>;
    const rebuild = commands.find((c) => c.command === 'ss14editor.rebuildSchema');
    assert.ok(rebuild, 'ss14editor.rebuildSchema is not contributed');
    assert.strictEqual(rebuild.category, 'SS14');

    await ext?.activate();
    const registered = await vscode.commands.getCommands(true);
    assert.ok(
      registered.includes('ss14editor.rebuildSchema'),
      'ss14editor.rebuildSchema is not registered after activation',
    );
  });

  test('the "SS14: Rebuild prototype index" command is contributed and registered', async () => {
    const ext = vscode.extensions.getExtension(QUALIFIED_EXTENSION_ID);
    const commands = (ext?.packageJSON?.contributes?.commands ?? []) as Array<{
      command: string;
      title: string;
      category?: string;
    }>;
    const rebuild = commands.find((c) => c.command === 'ss14editor.rebuildPrototypeIndex');
    assert.ok(rebuild, 'ss14editor.rebuildPrototypeIndex is not contributed');
    assert.strictEqual(rebuild.title, 'Rebuild prototype index');
    assert.strictEqual(rebuild.category, 'SS14');

    await ext?.activate();
    const registered = await vscode.commands.getCommands(true);
    assert.ok(
      registered.includes('ss14editor.rebuildPrototypeIndex'),
      'ss14editor.rebuildPrototypeIndex is not registered after activation',
    );
  });

  test('no sidebar view or activity-bar container is contributed (issue #45)', () => {
    const ext = vscode.extensions.getExtension(QUALIFIED_EXTENSION_ID);
    const contributes = ext?.packageJSON?.contributes ?? {};
    assert.strictEqual(contributes.viewsContainers, undefined, 'viewsContainers should not be contributed');
    assert.strictEqual(contributes.views, undefined, 'views should not be contributed');
  });
});
