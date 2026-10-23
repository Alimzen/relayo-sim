import { isRelayoError, type BaseMessage, type Driver } from '@alimzen/relayo';

/**
 * Remembers connections that keep failing with transient errors (provider down, timeouts, rate limits), so
 * sends try them last for a while instead of waiting on them first every time. Per process: after a
 * restart every connection starts healthy again.
 */
export class CircuitBreaker {
  private readonly failures = new Map<string, { count: number; pausedUntil: number }>();

  constructor(
    /** Consecutive transient failures that pause a connection. */
    private readonly threshold = 3,
    private readonly pauseMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Until when a connection is paused, if it is. */
  pausedUntil(id: string): Date | undefined {
    const state = this.failures.get(id);
    return state && state.pausedUntil > this.now() ? new Date(state.pausedUntil) : undefined;
  }

  /** The connections in their order, paused ones moved to the end: still tried if every other one fails. */
  order<T extends { id: string }>(connections: T[]): T[] {
    const paused = connections.filter((c) => this.pausedUntil(c.id));
    return [...connections.filter((c) => !paused.includes(c)), ...paused];
  }

  success(id: string): void {
    this.failures.delete(id);
  }

  failure(id: string): void {
    const state = this.failures.get(id) ?? { count: 0, pausedUntil: 0 };
    state.count++;
    // A paused connection that fails again on its next try is paused again at once.
    if (state.count >= this.threshold) state.pausedUntil = this.now() + this.pauseMs;
    this.failures.set(id, state);
  }

  /** The driver, reporting each send's outcome. Only transient errors count: a bad address is not the connection's fault. */
  watch<M extends BaseMessage>(id: string, driver: Driver<M>): Driver<M> {
    return {
      name: driver.name,
      channel: driver.channel,
      capabilities: driver.capabilities,
      send: async (message, context) => {
        try {
          const result = await driver.send(message, context);
          this.success(id);
          return result;
        } catch (error) {
          if (isRelayoError(error) && error.retryable) this.failure(id);
          throw error;
        }
      },
    };
  }
}
