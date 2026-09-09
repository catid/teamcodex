export {};
// Test-only transport: authentication stays local and unexpected traffic fails closed.
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], options?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin === 'https://auth.openai.com') {
    return originalFetch(new URL(url.pathname, process.env.MOCK_OAUTH_URL), options);
  }
  if (url.origin === process.env.MOCK_OAUTH_URL) return originalFetch(input, options);
  throw new Error(`Offline OAuth test blocked ${url.origin}`);
}, { preconnect: originalFetch.preconnect });
