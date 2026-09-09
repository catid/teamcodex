import type { Quota } from './accounts.ts';

/**
 * Parse a reset header value into a ms timestamp.
 * Codex sends `x-codex-*-reset-at` as unix seconds; be tolerant of ms too.
 */
function parseResetAt(value: string): number | null {
  const n = Number(value);
  if (Number.isNaN(n)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Parse OpenAI x-ratelimit-reset-* durations like "1s", "6m0s", "250ms".
 */
function parseResetDuration(value: string | undefined, now: number): number | null {
  if (!value) return null;
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let match = re.exec(value);
  let matched = false;
  while (match !== null) {
    matched = true;
    const n = parseFloat(match[1] ?? '');
    switch (match[2]) {
      case 'ms': ms += n; break;
      case 's': ms += n * 1000; break;
      case 'm': ms += n * 60_000; break;
      case 'h': ms += n * 3_600_000; break;
      case 'd': ms += n * 86_400_000; break;
    }
    match = re.exec(value);
  }
  return matched ? now + ms : null;
}

/** Apply provider quota headers to one account's quota state. */
export function updateQuotaHeaders(q: Quota, headers: Record<string, string | undefined>, now = Date.now()): void {
    // Codex rate limit windows (ChatGPT accounts) — percent is 0-100
    const pUsed = parseFloat(headers['x-codex-primary-used-percent'] ?? '');
    const sUsed = parseFloat(headers['x-codex-secondary-used-percent'] ?? '');
    if (!Number.isNaN(pUsed)) q.primary = pUsed / 100;
    if (!Number.isNaN(sUsed)) q.secondary = sUsed / 100;

    const pWin = parseInt(headers['x-codex-primary-window-minutes'] ?? '', 10);
    const sWin = parseInt(headers['x-codex-secondary-window-minutes'] ?? '', 10);
    if (!Number.isNaN(pWin)) q.primaryWindowMins = pWin;
    if (!Number.isNaN(sWin)) q.secondaryWindowMins = sWin;

    if (headers['x-codex-primary-reset-at']) {
      q.primaryReset = parseResetAt(headers['x-codex-primary-reset-at']);
    } else if (headers['x-codex-primary-reset-after-seconds']) {
      q.primaryReset = now + parseFloat(headers['x-codex-primary-reset-after-seconds'] ?? '') * 1000;
    }
    if (headers['x-codex-secondary-reset-at']) {
      q.secondaryReset = parseResetAt(headers['x-codex-secondary-reset-at']);
    } else if (headers['x-codex-secondary-reset-after-seconds']) {
      q.secondaryReset = now + parseFloat(headers['x-codex-secondary-reset-after-seconds'] ?? '') * 1000;
    }

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['x-ratelimit-limit-tokens'] ?? '', 10);
    const tokensRemaining = parseInt(headers['x-ratelimit-remaining-tokens'] ?? '', 10);
    const requestsLimit = parseInt(headers['x-ratelimit-limit-requests'] ?? '', 10);
    const requestsRemaining = parseInt(headers['x-ratelimit-remaining-requests'] ?? '', 10);

    if (!Number.isNaN(tokensLimit)) q.tokensLimit = tokensLimit;
    if (!Number.isNaN(tokensRemaining)) q.tokensRemaining = tokensRemaining;
    if (!Number.isNaN(requestsLimit)) q.requestsLimit = requestsLimit;
    if (!Number.isNaN(requestsRemaining)) q.requestsRemaining = requestsRemaining;

    const reset = parseResetDuration(headers['x-ratelimit-reset-tokens'], now)
      || parseResetDuration(headers['x-ratelimit-reset-requests'], now);
    if (reset) q.resetsAt = reset;

}
