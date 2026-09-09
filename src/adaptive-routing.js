/** @typedef {{inFlight: number, latencyMs: number, failureRate: number, samples: number, updatedAt: number}} Metrics */

/** Account-local EWMA feedback; never reads or mutates usage reset state. */
export class AdaptiveRouting {
  /** @param {() => number} [now] Monotonic clock in milliseconds. */
  constructor(now = () => performance.now()) {
    this.now = now;
    /** @type {WeakMap<object, Metrics>} */
    this.metrics = new WeakMap();
  }

  /** @param {object} account @returns {Metrics} */
  state(account) {
    let state = this.metrics.get(account);
    if (!state) {
      state = { inFlight: 0, latencyMs: 1000, failureRate: 0, samples: 0, updatedAt: this.now() };
      this.metrics.set(account, state);
    }
    return state;
  }

  /** @param {object} account @returns {Metrics} */
  status(account) { return { ...this.state(account) }; }

  /** @param {object} account @param {number} configuredWeight @returns {number} */
  weight(account, configuredWeight) {
    const state = this.state(account);
    // Forget stale evidence toward a neutral one-second prior (30-second half-life).
    const decay = 2 ** (-Math.max(0, this.now() - state.updatedAt) / 30_000);
    const latency = 1000 + (state.latencyMs - 1000) * decay;
    const failures = state.failureRate * decay;
    const quality = Math.max(0.05, Math.min(2, 1000 / Math.max(50, latency)) * (1 / (1 + 9 * failures)));
    return configuredWeight * quality / (state.inFlight + 1);
  }

  /** Reserve before asynchronous refresh/fetch; release is idempotent.
   * @param {object} account
   * @returns {{observe: (failed: boolean, latencyMs?: number) => void, release: () => void}}
   */
  start(account) {
    const state = this.state(account);
    const started = this.now();
    state.inFlight++;
    let released = false;
    let observed = false;
    return {
      observe: (failed, latencyMs = this.now() - started) => {
        if (observed) return;
        observed = true;
        const sample = Math.max(1, Math.min(60_000, latencyMs));
        state.latencyMs = state.samples ? state.latencyMs * 0.8 + sample * 0.2 : sample;
        state.failureRate = state.failureRate * 0.8 + (failed ? 0.2 : 0);
        state.samples++;
        state.updatedAt = this.now();
      },
      release: () => {
        if (released) return;
        released = true;
        state.inFlight--;
      },
    };
  }
}
