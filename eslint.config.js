import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';

export default defineConfig([
  { files: ['e2e/tui.test.js'], languageOptions: { globals: { window: 'readonly', document: 'readonly' } } },
  {
    files: ['**/*.js'],
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
]);
