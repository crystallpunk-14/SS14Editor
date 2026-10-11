import * as assert from 'node:assert';

import * as vscode from 'vscode';

import { INSPECTOR_VIEW_ID, QUALIFIED_EXTENSION_ID, VIEW_CONTAINER_ID } from '../../src/core';

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

  test('the inspector webview view is contributed', () => {
    const ext = vscode.extensions.getExtension(QUALIFIED_EXTENSION_ID);
    const views = (ext?.packageJSON?.contributes?.views ?? {}) as Record<
      string,
      Array<{ id: string; type?: string }>
    >;
    const contributed = Object.values(views).flat();
    const inspector = contributed.find((v) => v.id === INSPECTOR_VIEW_ID);
    assert.ok(inspector, `${INSPECTOR_VIEW_ID} view is not contributed`);
    assert.strictEqual(inspector.type, 'webview');
  });

  test('the inspector lives in its own activity-bar container, not the Explorer', () => {
    const ext = vscode.extensions.getExtension(QUALIFIED_EXTENSION_ID);
    const contributes = ext?.packageJSON?.contributes ?? {};

    const containers = (contributes.viewsContainers?.activitybar ?? []) as Array<{ id: string }>;
    assert.ok(
      containers.some((c) => c.id === VIEW_CONTAINER_ID),
      `activity-bar container ${VIEW_CONTAINER_ID} is not contributed`,
    );

    const views = (contributes.views ?? {}) as Record<string, Array<{ id: string }>>;
    assert.ok(
      views[VIEW_CONTAINER_ID]?.some((v) => v.id === INSPECTOR_VIEW_ID),
      `${INSPECTOR_VIEW_ID} is not in the ${VIEW_CONTAINER_ID} container`,
    );
    assert.ok(
      !(views.explorer ?? []).some((v) => v.id === INSPECTOR_VIEW_ID),
      `${INSPECTOR_VIEW_ID} should no longer be contributed to the Explorer`,
    );
  });
});
