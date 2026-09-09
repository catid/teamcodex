export interface AdaptiveMetrics {
  inFlight: number;
  latencyMs: number;
  failureRate: number;
  samples: number;
  updatedAt: number;
}

export interface Attempt {
  observe(failed: boolean, latencyMs?: number): void;
  release(): void;
}

/** Account-local EWMA feedback, independent of persistence and usage resets. */

export class AdaptiveRouting {
  private readonly now: () => number;
  private readonly metrics = new WeakMap<object, AdaptiveMetrics>();
  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  private state(account: object): AdaptiveMetrics {
    let state = this.metrics.get(account);
    if (!state) {
      state = { inFlight: 0, latencyMs: 1000, failureRate: 0, samples: 0, updatedAt: this.now() };
      this.metrics.set(account, state);
    }
    return state;
  }

  status(account: object): AdaptiveMetrics { return { ...this.state(account) }; }

  weight(account: object, configuredWeight: number): number {
    const state = this.state(account);
    // Forget stale evidence toward a neutral one-second prior (30-second half-life).
    const decay = 2 ** (-Math.max(0, this.now() - state.updatedAt) / 30_000);
    const latency = 1000 + (state.latencyMs - 1000) * decay;
    const failures = state.failureRate * decay;
    const quality = Math.max(0.05, Math.min(2, 1000 / Math.max(50, latency)) * (1 / (1 + 9 * failures)));
    return configuredWeight * quality / (state.inFlight + 1);
  }

  start(account: object): Attempt {
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
