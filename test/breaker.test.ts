import { ProviderUnavailableError, RejectedError, type Driver, type SmsMessage } from '@alimzen/relayo';
import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/live/breaker.js';

describe('circuit breaker', () => {
  it('pauses a connection after repeated transient failures, and puts it last while paused', () => {
    let now = 0;
    const breaker = new CircuitBreaker(3, 60_000, () => now);
    const connections = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    breaker.failure('a');
    breaker.failure('a');
    expect(breaker.order(connections).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    breaker.failure('a');
    expect(breaker.pausedUntil('a')).toEqual(new Date(60_000));
    expect(breaker.order(connections).map((c) => c.id)).toEqual(['b', 'c', 'a']);

    // After the pause it is tried again in its place; one more failure pauses it at once.
    now = 60_001;
    expect(breaker.order(connections).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    breaker.failure('a');
    expect(breaker.pausedUntil('a')).toEqual(new Date(120_001));

    // A success clears it.
    breaker.success('a');
    expect(breaker.pausedUntil('a')).toBeUndefined();
  });

  it('counts only transient errors of the watched driver', async () => {
    const breaker = new CircuitBreaker(1);
    let error: Error = new RejectedError('bad number', { provider: 'x' });
    const driver: Driver<SmsMessage> = {
      name: 'x',
      channel: 'sms',
      capabilities: { batch: false, attachments: false, scheduling: false, tracking: false, webhooks: false },
      send: async () => {
        throw error;
      },
    };
    const watched = breaker.watch('x', driver);
    const send = () => watched.send({ to: { address: '+1' }, body: 'x' }, { messageId: 'm' });

    await expect(send()).rejects.toBe(error);
    expect(breaker.pausedUntil('x')).toBeUndefined();
    error = new ProviderUnavailableError('down', { provider: 'x' });
    await expect(send()).rejects.toBe(error);
    expect(breaker.pausedUntil('x')).toBeInstanceOf(Date);
  });
});
