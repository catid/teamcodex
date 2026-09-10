import { join } from 'node:path';

import { errorMessage } from '@teamcodex/core/errors';
import { writeFile } from '@teamcodex/shared/filesystem';

function logTimestamp() {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export async function writeRequestLog(logDir: string | null, reqId: number, sections: string[]): Promise<void> {
  if (!logDir) return;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  try {
    await writeFile(join(logDir, filename), sections.join('\n\n'), 'utf-8');
  } catch (err) {
    console.error(errorMessage('REQUEST_LOG_FAILED', { message: (err instanceof Error ? err.message : String(err)) }));
  }
}

export function formatHeaders(headers: Headers | Record<string, string>): string {
  if (headers instanceof Headers) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

