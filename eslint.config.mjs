import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'out/', 'node_modules/', '.vscode-test/', '*.vsix', 'rider-plugin/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // Types cover global provenance; `no-undef` only produces false positives on TS.
      'no-undef': 'off',
    },
  },
  {
    // Node build/config scripts.
    files: ['*.mjs', '*.config.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  {
    // The single test seam: the pure core must never reach for the VS Code API
    // or the host adapter. Enforced here so CI fails if the boundary is crossed.
    files: ['src/core/**/*.ts', 'test/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                'The core layer must not depend on the vscode API — it is the pure, VS-Code-free test seam.',
            },
          ],
          patterns: ['**/host/**'],
        },
      ],
    },
  },
);
