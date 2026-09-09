import type { Config } from '@teamcodex/core/config';
import type { Counters } from '@teamcodex/core/usage';
import type { AccountManager } from '@teamcodex/proxy/account-manager';

import { normalizeStatus } from './status-data.ts';
type Status = ReturnType<typeof normalizeStatus>;
type StatusAccount = ReturnType<AccountManager['getStatus']>['accounts'][number];
interface StatusOptions { columns?: number | string | undefined; color?: boolean; compact?: boolean; now?: number }
type Tone = 'title' | 'cyan' | 'green' | 'yellow' | 'red' | 'dim' | 'bold';

import { stripVTControlCharacters } from 'node:util';

import { createError } from '@teamcodex/core/errors';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  // eslint-disable-next-line no-control-regex -- Strip or test terminal control sequences.
const clean = (value: unknown): string => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
const time = (value: unknown): number => typeof value === 'number' ? value : Date.parse(typeof value === 'string' ? value : '');
const compact = (value: unknown): string => finite(value) ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const number = (value: unknown): string => finite(value) ? Math.round(value).toLocaleString('en-US') : '—';
const tokens = (value: Partial<Counters> | null | undefined): number => (value?.inputTokens || 0) + (value?.outputTokens || 0);

function cellWidth(char: string): number {
  if (/\p{Mark}/u.test(char)) return 0;
  const code = char.codePointAt(0) ?? 0;
  return /\p{Extended_Pictographic}/u.test(char) || (code >= 0x1100 && (
    code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ||
    code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 ||
    code >= 0x20000 && code <= 0x3ffff)) ? 2 : 1;
}
export const displayWidth = (value: unknown): number => [...clean(value)].reduce((sum, char) => sum + cellWidth(char), 0);
function fit(value: unknown, width: number): string {
  let result = '', size = 0;
  const text = clean(value);
  const truncate = displayWidth(text) > width;
  for (const char of text) {
    const next = cellWidth(char);
    if (size + next > width - (truncate ? 1 : 0)) break;
    result += char;
    size += next;
  }
  if (truncate) { result += '…'; size++; }
  return result + ' '.repeat(Math.max(0, width - size));
}

export function duration(ms: unknown): string {
  if (!finite(ms)) return 'unknown';
  let seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  if (days) return `${days}d${hours ? ` ${hours}h` : ''}`;
  if (hours) return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  return `${minutes}m`;
}
const age = (value: unknown, now: number) => finite(time(value)) ? `${duration(now - time(value))} ago` : 'never';
const until = (value: unknown, now: number) => !finite(time(value)) ? 'time unknown' : time(value) <= now ? 'due now' : `in ${duration(time(value) - now)}`;
const pct = (value: unknown): string => finite(value) ? `${(value * 100).toFixed(1)}%` : 'unknown';
const ratio = (remaining: unknown, limit: unknown) => finite(remaining) && finite(limit) && limit > 0 ? 1 - remaining / limit : null;

function windows(account: StatusAccount): { name: string; value: number | null; reset: number | null; remaining?: string }[] {
  const q = account.quota || {};
  const label = (minutes: number | null, fallback: string) => minutes === 10080 ? 'Weekly' : finite(minutes) && minutes > 0 ? duration(minutes * 60000) : fallback;
  if (account.type !== 'chatgpt') return [
    { name: 'Token limit', value: ratio(q.tokensRemaining, q.tokensLimit), reset: q.resetsAt,
      remaining: finite(q.tokensRemaining) ? `${number(q.tokensRemaining)} / ${number(q.tokensLimit)} remaining` : '' },
    { name: 'Request limit', value: ratio(q.requestsRemaining, q.requestsLimit), reset: q.resetsAt,
      remaining: finite(q.requestsRemaining) ? `${number(q.requestsRemaining)} / ${number(q.requestsLimit)} remaining` : '' },
  ];
  return [
    { name: label(q.primaryWindowMins, 'Primary'), value: q.primary, reset: q.primaryReset },
    { name: label(q.secondaryWindowMins, 'Secondary'), value: q.secondary, reset: q.secondaryReset },
    ...(account.additionalQuota || []).map(q => ({ name: q.name, value: q.utilization, reset: q.resetAt })),
  ];
}

function health(account: StatusAccount, now: number, threshold: number): { label: string; color: Tone } {
  if (account.status === 'error') return { label: 'Login needed', color: 'red' };
  if (account.status === 'exhausted') return { label: 'Exhausted', color: 'red' };
  if (account.status === 'throttled' && (!time(account.rateLimitedUntil) || time(account.rateLimitedUntil) > now)) {
    return { label: 'Cooling down', color: 'yellow' };
  }
  if (windows(account).slice(0, 2).some(w => finite(w.value) && w.value >= threshold && !(time(w.reset) <= now))) {
    return { label: 'Near limit', color: 'yellow' };
  }
  return { label: 'Ready', color: 'green' };
}

function sparkline(buckets: Counters[]) {
  const values = buckets.map(tokens), peak = Math.max(...values, 0);
  const levels = '▁▂▃▄▅▆▇█';
  return { peak, total: values.reduce((a, b) => a + b, 0),
    graph: values.map(value => value ? levels[Math.max(0, Math.ceil(value / peak * 8) - 1)] : '·').join('') };
}

export function renderStatus(input: unknown, { columns = 110, color = false, compact: brief = false, now = Date.now() }: StatusOptions = {}): string {
  const data: Status = normalizeStatus(input);
  const width = Math.floor(Math.max(30, Math.min(140, Number(columns) || 110)));
  const lines: string[] = [];
  const codes = { title: '1;36', cyan: '36', green: '32', yellow: '33', red: '31', dim: '90', bold: '1' };
  const paint = (text: string, tone?: Tone) => color && tone && codes[tone] ? `\x1b[${codes[tone]}m${text}\x1b[0m` : text;
  function line(value = '', tone?: Tone, indent = 2) {
    const text = clean(value);
    const available = width - indent;
    let part = '', used = 0, wrapped = false;
    const emit = () => { lines.push(' '.repeat(indent) + paint(part, tone)); part = ''; used = 0; wrapped = true; };
    for (const word of text.split(/( +)/)) {
      if (used && used + displayWidth(word) > available) {
        part = part.trimEnd();
        emit();
      }
      if (wrapped && !used && /^ +$/.test(word)) continue;
      for (const char of word) {
        if (used + cellWidth(char) > available) emit();
        part += char; used += cellWidth(char);
      }
    }
    emit();
  }
  const rule = () => line('─'.repeat(width - 4), 'dim');
  const accounts = data.accounts || [];
  const threshold = data.switchThreshold ?? 0.98;
  const states = accounts.map(a => health(a, now, threshold));
  const ready = states.filter(s => s.label === 'Ready').length;
  const cooling = states.filter(s => s.label === 'Cooling down').length;
  const nearLimit = states.filter(s => s.label === 'Near limit').length;
  const attention = states.filter(s => s.color === 'red').length;
  line();
  line('TEAMCODEX   ● ONLINE', 'title');
  line(`${accounts.length} accounts  ·  ${ready} ready  ·  ${nearLimit} near limit  ·  ${cooling} cooling down  ·  ${attention} need attention`);
  if (data.service) line(`Uptime ${duration(data.service.uptimeSeconds * 1000)}  ·  ${number(data.service.inFlight)} requests in flight`, 'dim');

  const stats = data.statistics;
  if (stats) {
    const t = stats.totals;
    line();
    line(`${number(tokens(t))} TOKENS  ·  ${number(t.requests)} REQUESTS FINISHED`, 'bold');
    line(`Input ${compact(t.inputTokens)}  ·  Output ${compact(t.outputTokens)}  ·  Cached input ${compact(t.cachedInputTokens)} (included in input)`);
    line(`Upstream attempts ${number(t.attempts)}  ·  Retries ${number(t.retries)}  ·  HTTP errors ${number(t.httpErrors)}  ·  Disconnected ${number(t.disconnected)}`);
    line(`Average request ${t.requests ? duration(t.durationMs / t.requests) : '—'}  ·  Tracking since ${clean(stats.trackingSince).replace('T', ' ').slice(0, 19)} UTC`, 'dim');
    const today = stats.daily?.at(-1);
    const week = stats.daily?.slice(-7).reduce((n, b) => n + tokens(b), 0);
    line(`Today ${compact(tokens(today))} tokens  ·  Last 7 days ${compact(week)} tokens (UTC days)`, 'cyan');
    if (stats.hourly?.length) {
      const plot = sparkline(stats.hourly);
      line(`TOKENS / HOUR   ${plot.graph}   ${compact(plot.total)} total`, 'cyan');
      line(`24 UTC hour buckets, oldest → now  ·  Peak ${compact(plot.peak)} / hour  ·  · = zero`, 'dim');
    }
    if (stats.daily?.length && !brief) {
      const plot = sparkline(stats.daily);
      line(`TOKENS / DAY    ${plot.graph}`, 'cyan');
      line(`30 UTC day buckets, oldest → today  ·  Peak ${compact(plot.peak)} / day`, 'dim');
    }
    if (stats.persistenceError) line(stats.persistenceError, 'red');
    else if (stats.persistence === 'memory') line('History is in memory only for this service.', 'yellow');
  } else {
    const total = accounts.reduce((n, a) => n + (a.usage?.totalInputTokens || 0) + (a.usage?.totalOutputTokens || 0), 0);
    line(`${number(total)} tokens observed since service start  ·  Update the service to enable history`, 'dim');
  }
  line();
  const policy = data.autoReset;
  line(`Rotate at ${pct(threshold)}  ·  Earned resets ${policy?.enabled ? `on at ${pct(policy.threshold)}` : 'off'}`);
  if (policy) line(`Usage poll every ${duration((policy.pollIntervalSeconds ?? 300) * 1000)}  ·  ${data.usagePolling?.running ? 'checking accounts now' : `last finished ${age(data.usagePolling?.lastCompletedAt, now)}`}`, 'dim');
  rule();

  if (brief && width >= 85) {
    const nameWidth = width - 58;
    line(`${fit('ACCOUNT', nameWidth)}  ${fit('HEALTH', 13)} ${fit('PRIMARY', 9)} ${fit('SECONDARY', 9)} ${fit('CREDITS', 7)} TOKENS`, 'dim');
    accounts.forEach((a, i) => {
      const ws = windows(a);
      line(`${fit(`${a.name === data.currentAccount ? '▸' : ' '} ${a.name}`, nameWidth)}  ${fit(states[i]?.label ?? 'Ready', 13)} ${fit(pct(ws[0]?.value), 9)} ${fit(pct(ws[1]?.value), 9)} ${fit(a.type === 'chatgpt' ? a.usageReset?.availableCredits ?? '?' : 'n/a', 7)} ${compact(a.totals ? tokens(a.totals) : (a.usage?.totalInputTokens || 0) + (a.usage?.totalOutputTokens || 0))}`, a.name === data.currentAccount ? 'cyan' : undefined);
    });
  } else accounts.forEach((a, i) => {
    const state = states[i] ?? health(a, now, threshold);
    const reset = a.usageReset || {};
    const usage = a.usage || {};
    const total = a.totals;
    const auth = a.auth;
    line(`${String(i + 1).padStart(2, '0')}  ${a.name}${a.name === data.currentAccount ? '  ◀ SELECTED' : ''}`, 'bold');
    line(`${a.type === 'chatgpt' ? `ChatGPT · ${a.planType || 'plan unknown'}` : 'API key'}  ·  ${state.label}${state.label === 'Cooling down' ? ` · retry ${until(a.rateLimitedUntil, now)}` : ''}`, state.color, 6);
    for (const w of windows(a)) {
      const size = width < 65 ? 8 : 14;
      const filled = finite(w.value) ? Math.round(Math.max(0, Math.min(1, w.value)) * size) : 0;
      const bar = finite(w.value) ? '█'.repeat(filled) + '░'.repeat(size - filled) : '·'.repeat(size);
      line(`${w.name}  ${bar}  ${pct(w.value)} used  ·  resets ${until(w.reset, now)}`, finite(w.value) && w.value >= threshold ? 'yellow' : undefined, 6);
      if (w.remaining) line(w.remaining, 'dim', 6);
    }
    if (!brief) {
      line(`Tokens ${compact(total ? tokens(total) : (usage.totalInputTokens || 0) + (usage.totalOutputTokens || 0))}  ·  Input ${compact(total?.inputTokens ?? usage.totalInputTokens)} / Output ${compact(total?.outputTokens ?? usage.totalOutputTokens)}  ·  Attempts ${number(total?.attempts ?? usage.totalRequests)}`, undefined, 6);
      if (total) line(`Retries ${number(total.retries)}  ·  Finished requests ${number(total.requests)}  ·  HTTP errors ${number(total.httpErrors)}  ·  Last used ${age(usage.lastUsed, now)}`, 'dim', 6);
      const checked = time(a.quotaUpdatedAt || reset.checkedAt);
      const stale = finite(checked) && now - checked > Math.max(600000, (policy?.pollIntervalSeconds || 300) * 2000);
      line(`Usage observed ${age(a.quotaUpdatedAt || reset.checkedAt, now)}${stale ? ' · STALE' : ''}${reset.checkError ? ` · poll failed: ${reset.checkError}` : ''}`, stale || reset.checkError ? 'yellow' : 'dim', 6);
      if (a.type === 'chatgpt') {
        line(`Earned reset credits ${reset.availableCredits ?? 'unknown'}  ·  Last reset ${age(reset.lastCompletedAt, now)}${reset.lastResult ? ` · ${reset.lastResult.replaceAll('_', ' ')}` : ''}`, undefined, 6);
        if (reset.pending) line(`Reset confirmation pending · retry ${until(reset.retryAt, now)}`, 'yellow', 6);
        else if (time(reset.nextEligibleAt) > now) line(`New reset cooldown ends ${until(reset.nextEligibleAt, now)}`, 'dim', 6);
        if (auth) line(`Access token ${auth.expiresAt ? (time(auth.expiresAt) <= now ? 'expired' : `expires ${until(auth.expiresAt, now)}`) : 'expiry unknown'}  ·  Refresh ${auth.refreshing ? 'in progress' : auth.refreshAvailable ? 'available' : 'unavailable'}${time(auth.retryAt) > now ? ` · retry ${until(auth.retryAt, now)}` : ''}`, 'dim', 6);
      }
      if (state.label === 'Login needed') line('Reauthenticate this account with teamcodex login.', 'yellow', 6);
    }
    line();
  });
  if (!accounts.length) line('No accounts configured. Add one with teamcodex login.', 'yellow');
  rule();
  if (data.rotationOrder?.length) line(`Rotation  ${data.rotationOrder.join(' → ')}`, 'dim');
  line('Token totals cover this proxy only; quota % includes provider-side usage.', 'dim');
  line('Cached tokens are included in input. Missing upstream usage is not estimated.', 'dim');
  line();
  return lines.join('\n');
}

export async function statusCommand(config: Config, args: string[] = []): Promise<void> {
  if (args.some(arg => !['--json', '--compact', '--no-color'].includes(arg)) || args.includes('--json') && args.includes('--compact')) {
    throw createError('STATUS_ARGUMENTS_INVALID');
  }
  const base = process.env.TEAMCODEX_SERVER_URL || `http://127.0.0.1:${config.proxy.port}`;
  let data: unknown;
  try {
    const response = await fetch(`${base}/teamcodex/status`, {
      headers: { 'x-api-key': config.proxy.apiKey }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw createError('PROXY_HTTP_ERROR', { status: response.status });
    data = await response.json();
  } catch (error) {
    throw createError('STATUS_READ_FAILED', { message: (error instanceof Error ? error.message : String(error)) }, { cause: error });
  }
  if (args.includes('--json')) console.log(JSON.stringify(data, null, 2));
  else console.log(renderStatus(data, {
    columns: process.env.COLUMNS || process.stdout.columns,
    color: Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env) && !args.includes('--no-color') && process.env.TERM !== 'dumb',
    compact: args.includes('--compact'),
  }));
}
