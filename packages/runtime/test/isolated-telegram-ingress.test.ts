import { describe, expect, it } from 'vitest';
import { isolatedTelegramIngress } from '../scenarios/isolated-telegram-ingress';

const identities = { alpha: { subject: 101, timezone: 'Asia/Kolkata' }, beta: { subject: 202, timezone: 'UTC' } };

describe('isolated two-owner Telegram ingress transport', () => {
  it('routes verified subjects to separate listeners and intercepts outbound replies', async () => {
    const world = isolatedTelegramIngress(identities, async (owner, text) => `${owner}: ${text}`);
    const a = await world.deliver('alpha', 'first');
    const b = await world.deliver('beta', 'second');
    expect(a.outcome).toBe('answered');
    expect(b.outcome).toBe('answered');
    expect(a.sends.filter((call) => call.method === 'sendMessage')).toEqual([{ method: 'sendMessage', request: { chat_id: 101, text: 'alpha: first' } }]);
    expect(b.sends.filter((call) => call.method === 'sendMessage')).toEqual([{ method: 'sendMessage', request: { chat_id: 202, text: 'beta: second' } }]);
    expect(world.snapshot('alpha').sends).toEqual(a.sends);
    expect(a.hops.some((entry) => entry.hop === 'turn' && entry.ok)).toBe(true);
  });
  it('starts a fresh world for every trial, rejects duplicate identities', async () => {
    const first = isolatedTelegramIngress(identities, async (_owner, text) => text);
    await first.deliver('alpha', 'one');
    const second = isolatedTelegramIngress(identities, async (_owner, text) => text);
    expect(second.snapshot('alpha').sends).toEqual([]);
    expect(second.snapshot('beta').sends).toEqual([]);
    expect(() => isolatedTelegramIngress({ alpha: identities.alpha, beta: { subject: 101, timezone: 'UTC' } }, async () => 'x')).toThrow(/duplicate/);
  });
});
