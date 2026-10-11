import * as vscode from 'vscode';

import { QUALIFIED_EXTENSION_ID } from '../core';
import { ForkStatusController } from './fork-status-controller';
import { INSPECTOR_VIEW_ID, InspectorViewProvider } from './inspector-view';
import { PrototypeIndexController } from './prototype-index-controller';
import { SchemaController } from './schema-controller';
import { TextProviderController } from './text-providers';

export const REBUILD_SCHEMA_COMMAND = 'ss14editor.rebuildSchema';
export const REBUILD_PROTOTYPE_INDEX_COMMAND = 'ss14editor.rebuildPrototypeIndex';

export function activate(context: vscode.ExtensionContext): void {
  const manifest = vscode.extensions.getExtension(QUALIFIED_EXTENSION_ID)?.packageJSON as
    | { version?: string }
    | undefined;
  const version = manifest?.version ?? '0.0.0';

  const log = vscode.window.createOutputChannel('SS14 Editor');
  const forkStatus = new ForkStatusController();
  const schema = new SchemaController(context, forkStatus);
  const prototypeIndex = new PrototypeIndexController(context, forkStatus, log);
  const textProviders = new TextProviderController(forkStatus, schema);

  context.subscriptions.push(
    log,
    forkStatus,
    schema,
    prototypeIndex,
    textProviders,
    vscode.commands.registerCommand(REBUILD_SCHEMA_COMMAND, () => schema.rebuild()),
    vscode.commands.registerCommand(REBUILD_PROTOTYPE_INDEX_COMMAND, () => prototypeIndex.rebuild()),
    vscode.window.registerWebviewViewProvider(
      INSPECTOR_VIEW_ID,
      new InspectorViewProvider(context.extensionUri, version, forkStatus, schema, prototypeIndex),
    ),
  );

  console.log(`SS14 Prototype Editor v${version} activated.`);
}

export function deactivate(): void {
  // No teardown needed: every disposable is registered on context.subscriptions.
}
