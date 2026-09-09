/** @typedef {{requests: number, input: number, output: number, inFlight: number}} Totals */
/** @param {Array<{usage: {totalRequests: number, totalInputTokens: number, totalOutputTokens: number}, adaptive?: {inFlight: number}}>} accounts @returns {Totals} */
function totals(accounts) {
  return accounts.reduce((sum, account) => ({
    requests: sum.requests + account.usage.totalRequests,
    input: sum.input + account.usage.totalInputTokens,
    output: sum.output + account.usage.totalOutputTokens,
    inFlight: sum.inFlight + (account.adaptive?.inFlight ?? 0),
  }), { requests: 0, input: 0, output: 0, inFlight: 0 });
}

/** Normalize the public status snapshot for all operator views.
 * Pool totals represent members; overall totals count each account once.
 * @param {ReturnType<import('./account-manager.js').AccountManager['getStatus']>} status
 */
export function telemetry(status) {
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
