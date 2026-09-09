import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: [".cache/**"] },
  { files: ['e2e/tui.test.ts'], languageOptions: { globals: { window: 'readonly', document: 'readonly' } } },
  {
    files: ['**/*.{js,ts}'],
    plugins: { 'simple-import-sort': simpleImportSort },
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'prefer-template': 'error',
      'no-restricted-syntax': ['error', {
        selector: 'AssignmentExpression[parent.type!="ExpressionStatement"][parent.type!="ForStatement"], ForStatement > AssignmentExpression.test',
        message: 'Keep assignments in standalone statements, not inside expressions.',
      }],
      'no-restricted-globals': ['error', {
        globals: [{
          name: 'isNaN',
          message: 'Use Number.isNaN after explicit numeric conversion; global isNaN coerces its input.',
        }],
        checkGlobalObject: true,
      }],
    },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['node:*', 'bun', 'bun:*', '@teamcodex/proxy', '@teamcodex/proxy/*', '@teamcodex/cli', '@teamcodex/cli/*', '**/proxy/**', '**/apps/**', '../../*'],
        message: 'Core owns pure domain policy; runtime I/O and application dependencies belong in proxy or CLI.',
      }] }],
    },
  },
  {
    files: ['packages/proxy/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['@teamcodex/cli', '@teamcodex/cli/*', '**/apps/**', '**/core/src/**'],
        message: 'Proxy consumes core through package exports and cannot depend on CLI.',
      }] }],
    },
  },
]);
