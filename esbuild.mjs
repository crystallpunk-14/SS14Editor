import { rmSync } from 'node:fs';

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/**
 * Bundles (issue #21):
 *   - host    : the thin VS Code adapter + pure core, CommonJS for the Extension Host
 *   - worker  : the prototype-index worker thread (issue #28), CommonJS, no `vscode`
 *
 * Plus one build-tooling bundle:
 *   - smoke   : the `@vscode/test-electron` activation test, compiled so the test CLI can run it
 */

/** @type {import('esbuild').BuildOptions} */
const hostConfig = {
  entryPoints: ['src/host/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node14',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

/**
 * The prototype-index worker thread (issue #28): loaded by the host with
 * `new Worker(dist/prototype-index-worker.js)`, so it is its own entry point.
 */
/** @type {import('esbuild').BuildOptions} */
const indexWorkerConfig = {
  ...hostConfig,
  entryPoints: ['src/host/prototype-index-worker.ts'],
  outfile: 'dist/prototype-index-worker.js',
  external: [],
};

/**
 * The stdio language server (Rider plan, stage 0 spike): core + vscode-free host
 * pieces, spawns the same worker bundle from `dist/`.
 */
/** @type {import('esbuild').BuildOptions} */
const serverConfig = {
  ...hostConfig,
  entryPoints: ['src/server/server.ts'],
  outfile: 'dist/server.js',
  external: [],
};

/** @type {import('esbuild').BuildOptions} */
const smokeConfig = {
  entryPoints: ['test/smoke/activation.test.ts'],
  outdir: 'out/test/smoke',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node14',
  external: ['vscode', 'mocha'],
  sourcemap: true,
  logLevel: 'info',
};

const configs = [hostConfig, indexWorkerConfig, serverConfig, smokeConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('esbuild: watching host, worker, smoke bundles...');
} else {
  // `vsce package` ships all of dist/, so start from an empty one: a bundle
  // whose entry point was removed would otherwise ride along in the .vsix.
  rmSync('dist', { recursive: true, force: true });
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
