import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// One runtime boundary for filesystem primitives used by applications and tooling.
export { existsSync } from 'node:fs';
export { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';

export interface AtomicWriteOptions {
  createDirectory?: boolean;
  mode?: number;
  beforeCommit?: () => boolean | Promise<boolean>;
}

/** Exclusive temporary file beside its destination; readers see either complete version. */
export async function atomicWrite(path: string, content: string, options: AtomicWriteOptions = {}): Promise<boolean> {
  if (options.createDirectory) await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: options.mode ?? 0o600, flag: 'wx' });
    if (options.beforeCommit && !await options.beforeCommit()) return false;
    await rename(temporary, path);
    return true;
  } finally { await rm(temporary, { force: true }); }
}

/** This is an optimistic content check, not a cross-process compare-and-swap. */
export function replaceFileIfMatching(path: string, content: string, expected: string, isCurrent: () => boolean): Promise<boolean> {
  return atomicWrite(path, content, { createDirectory: true,
    beforeCommit: async () => await readFile(path, 'utf8') === expected && isCurrent() });
}

export async function readTextFile(path: string, maxBytes: number, invalid: () => Error): Promise<string> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw invalid();
    const content = await file.readFile('utf8');
    if (Buffer.byteLength(content) > maxBytes) throw invalid();
    return content;
  } finally { await file.close(); }
}

/** Directory creation provides an exclusive lock across cooperating local processes. */
export async function withFileLock<T>(path: string, action: () => Promise<T>, locked: (cause: unknown) => Error): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw locked(error);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally { await rm(path, { recursive: true, force: true }); }
}
