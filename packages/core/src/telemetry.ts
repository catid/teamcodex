import type { AccountUsage, UsageResetStatus } from './accounts.ts';
import type { RoutingConfig } from './routing/config.ts';

export interface Totals { requests: number; input: number; output: number; inFlight: number }
export interface TelemetryAccount {
  name: string;
  type: 'chatgpt' | 'apikey';
  usage: AccountUsage;
  adaptive?: { inFlight: number };
  usageReset?: UsageResetStatus;
}
export interface TelemetryStatus<T extends TelemetryAccount> {
  accounts: T[];
  routing?: RoutingConfig | undefined;
  currentAccount?: string | undefined;
}

function totals(accounts: readonly TelemetryAccount[]): Totals {
  return accounts.reduce((sum, account) => ({
    requests: sum.requests + account.usage.totalRequests,
    input: sum.input + account.usage.totalInputTokens,
    output: sum.output + account.usage.totalOutputTokens,
    inFlight: sum.inFlight + (account.adaptive?.inFlight ?? 0),
  }), { requests: 0, input: 0, output: 0, inFlight: 0 });
}

/** Pool totals count members; overall totals count each account once. */
export function telemetry<T extends TelemetryAccount>(status: TelemetryStatus<T>) {
  const accounts = status.accounts.map(account => ({
    ...account,
    auth: account.type === 'chatgpt' ? 'OAuth' : 'API key',
    resets: account.type === 'chatgpt' ? account.usageReset?.availableCredits ?? null : null,
    totals: totals([account]),
  }));
  const pools = Object.entries(status.routing?.pools ?? { default: { accounts: accounts.map(a => a.name) } }).map(([name, pool]) => {
    const members = accounts.filter(account => pool.accounts.includes(account.name));
    return { name, strategy: pool.strategy ?? (status.routing ? 'weighted-round-robin' : 'failover'), members, totals: totals(members) };
  });
  return { accounts, pools, totals: totals(accounts), currentAccount: status.currentAccount };
}
