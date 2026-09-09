import { createError } from '../errors.ts';

export type RoutingStrategy = 'failover' | 'weighted-round-robin' | 'adaptive';

export interface AccountRouting {
  name: string;
  weight?: number;
  enabled?: boolean;
  switchThreshold?: number;
}

export interface Pool {
  accounts: string[];
  strategy?: RoutingStrategy;
  switchThreshold?: number;
  maxConcurrentRequests?: number;
}

export interface RoutingConfig {
  defaultPool: string;
  pools: Record<string, Pool>;
}

export interface RoutingOptions {
  routing?: RoutingConfig;
  maxConcurrentRequests?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function threshold(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function integer(value: unknown, maximum: number): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximum);
}

function invalid(): never { throw createError('ROUTING_CONFIG_INVALID'); }

/** Validate untrusted routing fields before they enter persisted configuration. */
export function validateRouting(config: unknown): asserts config is RoutingOptions & { accounts: AccountRouting[] } {
  if (!isRecord(config) || !Array.isArray(config.accounts)) invalid();
  const names = new Set<string>();
  for (const account of config.accounts) {
    if (!isRecord(account) || typeof account.name !== 'string' ||
        !integer(account.weight, 1000) ||
        (account.enabled !== undefined && typeof account.enabled !== 'boolean') || !threshold(account.switchThreshold)) invalid();
    names.add(account.name);
  }
  if (!integer(config.maxConcurrentRequests, 10000)) invalid();
  if (config.routing === undefined) return;
  const routing = config.routing;
  if (!isRecord(routing) || !isRecord(routing.pools) ||
      typeof routing.defaultPool !== 'string' || !Object.hasOwn(routing.pools, routing.defaultPool)) invalid();
  if (names.size !== config.accounts.length) invalid();
  for (const [name, pool] of Object.entries(routing.pools)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !isRecord(pool) ||
        Object.keys(pool).some(key => !['accounts', 'strategy', 'switchThreshold', 'maxConcurrentRequests'].includes(key)) ||
        !Array.isArray(pool.accounts) || new Set(pool.accounts).size !== pool.accounts.length ||
        pool.accounts.some((account: unknown) => typeof account !== 'string' || !names.has(account)) ||
        (pool.strategy !== undefined && pool.strategy !== 'failover' && pool.strategy !== 'weighted-round-robin' && pool.strategy !== 'adaptive') ||
        !threshold(pool.switchThreshold) || !integer(pool.maxConcurrentRequests, 10000)) invalid();
  }
}

function preserveOverride<K extends 'weight' | 'enabled' | 'switchThreshold'>(previous: AccountRouting, next: AccountRouting, key: K): void {
  const value = previous[key];
  if (next[key] === undefined && value !== undefined) next[key] = value;
}

/** Preserve account policy and pool memberships when credentials or names change. */
export function preserveAccountRouting(config: RoutingOptions, previous: AccountRouting, next: AccountRouting): void {
  preserveOverride(previous, next, 'weight');
  preserveOverride(previous, next, 'enabled');
  preserveOverride(previous, next, 'switchThreshold');
  for (const pool of Object.values(config.routing?.pools ?? {})) {
    pool.accounts = pool.accounts.map(name => name === previous.name ? next.name : name);
  }
}
