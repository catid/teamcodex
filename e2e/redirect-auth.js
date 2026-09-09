// Test-only preload. Preserve the real refresh implementation, replacing only its
// transport destination. Block unexpected destinations before opening a socket.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(String(input));
  if (url.origin === 'https://auth.openai.com' && url.pathname === '/oauth/token') {
    return originalFetch('http://mock:8080/oauth/token', options);
  }
  if (!['mock', 'teamcodex', '127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`E2E blocked unexpected destination: ${url.origin}`);
  }
  return originalFetch(input, options);
};
