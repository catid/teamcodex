import { telemetry } from './telemetry.js';

/** @typedef {{name: string, type?: string, enabled?: boolean, status: string, usage: {totalRequests: number, totalInputTokens: number, totalOutputTokens: number}}} UsageAccount */

/** Build a plain-text usage view; shared accounts are counted once per pool.
 * @param {{accounts: UsageAccount[], routing?: {pools: Record<string, {accounts: string[]}>}}} status
 * @returns {string[]}
 */
export function usageLines(status) {
  const view = telemetry(status);
  const format = total => `${total.requests} requests | in ${total.input} | out ${total.output}`;
  const lines = [' Usage — since proxy start', '', ' Pools (member account totals)'];
  for (const pool of view.pools) {
    const members = pool.members;
    lines.push(` ${pool.name}: ${format(pool.totals)}`);
    lines.push(`   ${members.filter(a => a.enabled !== false && a.status === 'active').length}/${members.length} active accounts`);
  }
  lines.push('', ' Accounts');
  for (const account of view.accounts) {
    lines.push(` ${account.name} (${account.auth}) [${account.enabled === false ? 'disabled' : account.status}]`);
    lines.push(`   ${format(account.totals)}`);
  }
  lines.push('', ' Shared accounts appear in each pool; do not sum pools.');
  return lines;
}
