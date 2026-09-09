import { describe, expect, test } from 'bun:test';

import { AdaptiveRouting } from '../src/routing/adaptive.ts';
import { WeightedRoundRobin } from '../src/routing/weighted.ts';

describe('routing core', () => {
  test('weighted scheduling preserves capacity shares', () => {
    const scheduler = new WeightedRoundRobin();
    const accounts = [{ name: 'primary', weight: 3 }, { name: 'secondary', weight: 1 }];
    const routed = Array.from({ length: 400 }, () => scheduler.select('main', accounts)?.name);
    expect(routed.filter(name => name === 'primary')).toHaveLength(300);
    expect(scheduler.select('empty', [])).toBeNull();
  });

  test('replacement identities do not inherit a removed schedule entry', () => {
    const scheduler = new WeightedRoundRobin();
    const first = { name: 'a', weight: 1 };
    scheduler.select('main', [first]);
    const replacement = { name: 'a', weight: 1 };
    expect(scheduler.select('main', [replacement])).toBe(replacement);
  });

  test('feedback penalizes failures, releases once and decays toward recovery', () => {
    let now = 0;
    const feedback = new AdaptiveRouting(() => now);
    const account = {};
    const attempt = feedback.start(account);
    expect(feedback.status(account).inFlight).toBe(1);
    attempt.observe(true, 5000);
    attempt.observe(false, 1);
    attempt.release();
    attempt.release();
    expect(feedback.status(account).samples).toBe(1);
    expect(feedback.status(account).inFlight).toBe(0);
    expect(feedback.weight(account, 1)).toBeLessThan(feedback.weight({}, 1));
    now = 600_000;
    expect(feedback.weight(account, 1)).toBeGreaterThan(0.99);
  });
});
