import { createError } from './errors.js';

/** @typedef {{accounts: string[], strategy?: 'failover' | 'weighted-round-robin' | 'adaptive', switchThreshold?: number, maxConcurrentRequests?: number}} Pool */
/** @typedef {{defaultPool: string, pools: Record<string, Pool>}} RoutingConfig */

/** Validate optional routing policy and per-account overrides before persistence.
 * @param {{accounts: Array<{name: string, weight?: number, enabled?: boolean, switchThreshold?: number}>, routing?: RoutingConfig, maxConcurrentRequests?: number}} config
 * @returns {void}
 */
export function validateRouting(config) {
  const invalid = () => { throw createError('ROUTING_CONFIG_INVALID'); };
  const threshold = value => value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1);
  for (const account of config.accounts) {
    if ((account.weight !== undefined && (!Number.isInteger(account.weight) || account.weight < 1 || account.weight > 1000)) ||
        (account.enabled !== undefined && typeof account.enabled !== 'boolean') || !threshold(account.switchThreshold)) invalid();
  }
  const concurrency = value => value === undefined || (Number.isInteger(value) && value >= 1 && value <= 10000);
  if (!concurrency(config.maxConcurrentRequests)) invalid();
  if (config.routing === undefined) return;
  const routing = config.routing;
  if (!routing || typeof routing !== 'object' || Array.isArray(routing) ||
      !routing.pools || typeof routing.pools !== 'object' || Array.isArray(routing.pools) ||
      typeof routing.defaultPool !== 'string' || !Object.hasOwn(routing.pools, routing.defaultPool)) invalid();
  const names = new Set(config.accounts.map(a => a.name));
  if (names.size !== config.accounts.length) invalid();
  for (const [name, pool] of Object.entries(routing.pools)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !pool || typeof pool !== 'object' ||
        Object.keys(pool).some(key => !['accounts', 'strategy', 'switchThreshold', 'maxConcurrentRequests'].includes(key)) ||
        !Array.isArray(pool.accounts) || new Set(pool.accounts).size !== pool.accounts.length ||
        pool.accounts.some(account => !names.has(account)) ||
        !['failover', 'weighted-round-robin', 'adaptive'].includes(pool.strategy ?? 'weighted-round-robin') ||
        !threshold(pool.switchThreshold) || !concurrency(pool.maxConcurrentRequests)) invalid();
  }
}

/** Smooth weighted round-robin with state scoped to an eligible candidate set. */
export class WeightedRoundRobin {
  constructor() {
    /** @type {Map<string, {signature: string, weights: Map<object, number>}>} */
    this.pools = new Map();
  }
  /** @template {{name: string, weight: number}} T
   * @param {string} pool @param {T[]} accounts @param {(account: T) => number} [effectiveWeight] @returns {T | null}
   */
  select(pool, accounts, effectiveWeight = account => account.weight) {
    if (!accounts.length) { this.pools.delete(pool); return null; }
    const signature = JSON.stringify(accounts.map(a => [a.name, a.weight]));
    let state = this.pools.get(pool);
    if (!state || state.signature !== signature || accounts.some(a => !state.weights.has(a))) {
      state = { signature, weights: new Map(accounts.map(a => [a, 0])) };
      this.pools.set(pool, state);
    }
    let best = accounts[0];
    let total = 0;
    for (const account of accounts) {
      const contribution = effectiveWeight(account);
      const weight = (state.weights.get(account) ?? 0) + contribution;
      state.weights.set(account, weight);
      total += contribution;
      if (weight > state.weights.get(best)) best = account;
    }
    state.weights.set(best, state.weights.get(best) - total);
    return best;
  }
}

/** Preserve routing overrides when replacing credentials and update memberships on rename.
 * @param {{routing?: RoutingConfig, maxConcurrentRequests?: number}} config
 * @param {{name: string, weight?: number, enabled?: boolean, switchThreshold?: number}} previous
 * @param {{name: string, weight?: number, enabled?: boolean, switchThreshold?: number}} next
 * @returns {void}
 */
export function preserveAccountRouting(config, previous, next) {
  for (const key of ['weight', 'enabled', 'switchThreshold']) {
    if (next[key] === undefined && previous[key] !== undefined) next[key] = previous[key];
  }
  for (const pool of Object.values(config.routing?.pools ?? {})) {
    pool.accounts = pool.accounts.map(name => name === previous.name ? next.name : name);
  }
}
