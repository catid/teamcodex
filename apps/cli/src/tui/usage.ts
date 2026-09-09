import type { Totals } from '@teamcodex/core/telemetry';
import { telemetry } from '@teamcodex/core/telemetry';
import type { AccountManager } from '@teamcodex/proxy/account-manager';


export function usageLines(status: ReturnType<AccountManager['getStatus']>): string[] {
  const view = telemetry(status);
  const format = (total: Totals) => `${total.requests} requests | in ${total.input} | out ${total.output}`;
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
