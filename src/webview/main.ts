import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { initialState, render, type ViewState } from './store';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

let state: ViewState = vscode.getState<ViewState>() ?? initialState;
const app = document.getElementById('app');

if (app) render(app, state);

function update(patch: Partial<ViewState>): void {
  state = { ...state, ...patch };
  vscode.setState(state);
  if (app) render(app, state);
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'hello':
      update({ extensionVersion: message.extensionVersion });
      break;
    case 'forkStatus':
      update({ folder: message.folder });
      break;
    case 'schemaStatus':
      update({ schema: message.status });
      break;
    case 'indexStatus':
      update({ index: message.status });
      break;
  }
});

// Announce readiness so the host replies with the current state.
vscode.postMessage({ type: 'ready' });
