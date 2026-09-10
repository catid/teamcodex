import assert from 'node:assert/strict';

import { isRecord, validateConfig } from '@teamcodex/core/config';
import { readFile } from '@teamcodex/shared/filesystem';

/** Decode fixture files with the same boundary validation as the application. */
export async function readConfig(path: string) {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  validateConfig(value);
  return value;
}

export function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), 'Expected an object');
  return value;
}

export function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return object(value);
}

export function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'Expected an array');
  return value;
}

export function string(value: unknown): string {
  assert.equal(typeof value, 'string');
  assert.ok(typeof value === 'string');
  return value;
}
