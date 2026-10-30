import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * The stdio language server as a client sees it: `dist/server.js` (built by
 * `npm run build`) spoken to over JSON-RPC. No SS14 fork is needed — these pin
 * the handshake and what the server does where there is no fork; completion on
 * a real fork is exercised by the core tests and by hand in Rider.
 */

const SERVER = path.resolve(__dirname, '../../dist/server.js');

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

class TestClient {
  readonly notifications: Message[] = [];
  private readonly process: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private readonly pending = new Map<number, (message: Message) => void>();

  constructor() {
    this.process = spawn(process.execPath, [SERVER, '--stdio']);
    this.process.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
  }

  request(method: string, params: unknown): Promise<Message> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Resolves with the first notification of `method` (already received or still to come). */
  async waitFor(method: string, timeoutMs = 5000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.notifications.find((message) => message.method === method);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${method} within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  kill(): void {
    this.process.kill();
  }

  private write(message: object): void {
    const body = JSON.stringify(message);
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const separator = this.buffer.indexOf('\r\n\r\n');
      if (separator < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, separator).toString())?.[1]);
      if (this.buffer.length < separator + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(separator + 4, separator + 4 + length).toString()) as Message;
      this.buffer = this.buffer.subarray(separator + 4 + length);

      if (message.method === undefined && message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.method !== undefined && message.id !== undefined) {
        // A server request (capability registration, progress creation): accept it.
        this.write({ jsonrpc: '2.0', id: message.id, result: null });
      } else {
        this.notifications.push(message);
      }
    }
  }
}

let client: TestClient | undefined;
let folder: string | undefined;

afterEach(() => {
  client?.kill();
  client = undefined;
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

/** A started server on a fresh folder that has a prototype directory but is no SS14 fork. */
async function startOnPlainFolder() {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss14editor-server-'));
  fs.mkdirSync(path.join(folder, 'Resources', 'Prototypes'), { recursive: true });
  const rootUri = pathToFileURL(folder).toString();
  client = new TestClient();
  const initialized = await client.request('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: path.basename(folder) }],
    capabilities: { window: { workDoneProgress: true } },
    initializationOptions: { storagePath: path.join(folder, '.storage') },
  });
  client.notify('initialized', {});
  return { client, folder, initialized };
}

describe('language server', () => {
  it('announces completion, hover, definition and the two rebuild commands', async () => {
    const { initialized } = await startOnPlainFolder();
    const result = initialized.result as { capabilities: Record<string, unknown> };
    expect(result.capabilities).toMatchObject({
      completionProvider: { triggerCharacters: [' ', ':', '/'] },
      hoverProvider: true,
      definitionProvider: true,
      executeCommandProvider: {
        commands: ['ss14editor.rebuildSchema', 'ss14editor.rebuildPrototypeIndex'],
      },
    });
  });

  it('logs and shows why a folder that is not a fork gets no features', async () => {
    const { client } = await startOnPlainFolder();
    const log = await client.waitFor('window/logMessage');
    expect((log.params as { message: string }).message).toMatch(/^\[fork\] .*Not an SS14 fork/);

    const shown = await client.waitFor('window/showMessage');
    expect(shown.params).toMatchObject({ type: 2, message: expect.stringContaining('Not an SS14 fork') });
  });

  it('completes nothing in a prototype file when there is no fork', async () => {
    const { client, folder } = await startOnPlainFolder();
    const uri = pathToFileURL(path.join(folder, 'Resources', 'Prototypes', 'a.yml')).toString();
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'yaml', version: 1, text: '- type: entity\n  components:\n  - type: \n' },
    });
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 2, character: 10 },
    });
    expect(completion.result).toEqual([]);
  });

  it('never asks the client to open the list when there is no fork', async () => {
    const { client, folder } = await startOnPlainFolder();
    const uri = pathToFileURL(path.join(folder, 'Resources', 'Prototypes', 'a.yml')).toString();
    const text = ['- type: entity', '  components:', '  - type: ', ''].join('\n');
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'yaml', version: 1, text } });
    for (const reason of ['accepted', 'deletion', 'newline']) {
      const answer = await client.request('ss14/shouldSuggest', { uri, text, offset: text.length - 1, reason });
      expect(answer.result).toBe(false);
    }
  });

  it('runs the rebuild commands without a fork, logging why the index is skipped', async () => {
    const { client } = await startOnPlainFolder();
    await client.request('workspace/executeCommand', { command: 'ss14editor.rebuildSchema', arguments: [] });
    await client.request('workspace/executeCommand', { command: 'ss14editor.rebuildPrototypeIndex', arguments: [] });
    const skipped = await waitForLog(client, /\[index\] rebuild skipped/);
    expect(skipped).toBeDefined();
  });
});

async function waitForLog(client: TestClient, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = client.notifications
      .filter((message) => message.method === 'window/logMessage')
      .map((message) => (message.params as { message: string }).message)
      .find((message) => pattern.test(message));
    if (line) return line;
    if (Date.now() > deadline) throw new Error(`no log line matching ${pattern} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
