export interface WeightedAccount {
  name: string;
  weight: number;
}

interface Schedule {
  signature: string;
  weights: Map<object, number>;
}

/** Smooth weighted round-robin; state follows the eligible candidate set. */
export class WeightedRoundRobin {
  private readonly pools = new Map<string, Schedule>();
  select<T extends WeightedAccount>(pool: string, accounts: readonly T[], effectiveWeight: (account: T) => number = account => account.weight): T | null {
    if (!accounts.length) { this.pools.delete(pool); return null; }
    const signature = JSON.stringify(accounts.map(a => [a.name, a.weight]));
    const existing = this.pools.get(pool);
    let state = existing;
    if (!state || state.signature !== signature || accounts.some(a => !existing?.weights.has(a))) {
      state = { signature, weights: new Map(accounts.map(a => [a, 0])) };
      this.pools.set(pool, state);
    }
    let best = accounts[0];
    if (!best) return null;
    let total = 0;
    for (const account of accounts) {
      const contribution = effectiveWeight(account);
      const weight = (state.weights.get(account) ?? 0) + contribution;
      state.weights.set(account, weight);
      total += contribution;
      if (weight > (state.weights.get(best) ?? 0)) best = account;
    }
    state.weights.set(best, (state.weights.get(best) ?? 0) - total);
    return best;
  }
}

