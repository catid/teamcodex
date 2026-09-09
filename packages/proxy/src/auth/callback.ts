import http from 'node:http';

import { createError, errorMessage } from '@teamcodex/core/errors';

import { OAUTH_CALLBACK_PORT } from './constants.ts';

export interface AuthCode { code: string }

export function parseManualAuthInput(input: string, expectedState?: string): AuthCode | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url;
  try { url = new URL(trimmed); } catch { /* Raw code or query string. */ }
  const params = url ? url.searchParams :
    trimmed.includes('=') && trimmed.includes('&') ? new URLSearchParams(trimmed) : null;
  if (params) {
    if (expectedState && params.get('state') !== expectedState) throw createError('OAUTH_STATE_MISMATCH');
    const error = params.get('error');
    if (error) throw createError('OAUTH_PROVIDER_ERROR', { error });
    const code = params.get('code');
    if (!code) throw createError('OAUTH_CODE_MISSING');
    return { code };
  }
  return { code: trimmed };
}

export function startCallbackServer(expectedState: string): Promise<{ codePromise: Promise<AuthCode>; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const { promise: codePromise, resolve: resolveCode, reject: rejectCode } = Promise.withResolvers<AuthCode>();

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/auth/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        if (expectedState && state !== expectedState) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(errorMessage('OAUTH_STATE_REJECTED_PAGE'));
          rejectCode(createError('OAUTH_STATE_MISMATCH'));
          return;
        }

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(errorMessage('OAUTH_CALLBACK_REJECTED_PAGE'));
          rejectCode(createError('OAUTH_CALLBACK_ERROR', { error: error, description: url.searchParams.get('error_description') || '' }));
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Login successful</h2><p>You can close this tab and return to the terminal.</p></body></html>');
          resolveCode({ code });
          return;
        }
      }

      res.writeHead(404);
      res.end(errorMessage('OAUTH_NOT_FOUND'));
    });

    server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      resolve({ codePromise, server });
    });
    server.on('error', err => {
      if ('code' in err && err.code === 'EADDRINUSE') {
        reject(createError('OAUTH_PORT_BUSY', { port: OAUTH_CALLBACK_PORT }));
      } else {
        reject(err);
      }
    });

    // Timeout after 5 minutes (unref so it doesn't keep the process alive)
    const timer = setTimeout(() => {
      rejectCode(createError('OAUTH_LOGIN_TIMEOUT'));
      server.close();
    }, 300_000);
    timer.unref();
    server.on('close', () => clearTimeout(timer));
    server.on('error', () => clearTimeout(timer));
  });
}

