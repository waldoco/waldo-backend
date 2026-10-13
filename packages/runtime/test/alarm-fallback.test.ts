import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { armAlarm } from '../src/scheduler/alarm-slot';

// An alarm whose work throws before any lane re-arms must still leave the owner a next wake, or once the platform's
// retries run out the owner's briefs, reminders and heartbeat stop until their next message.
const { OwnerDO } = await import('../src/channels/owner-do');
const FALLBACK_MS = 30 * 60_000;
type Owner = Readonly<{ alarm(info?: AlarmInvocationInfo): Promise<void> }>;
const attempt = (retryCount: number): AlarmInvocationInfo => ({ retryCount, isRetry: retryCount > 0, scheduledTime: Date.now() });

const failingAlarm = (name: string, check: (owner: Owner, state: DurableObjectState, lines: () => string[]) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' }) as unknown as Owner;
    const drain = vi.spyOn(OwnerDO.prototype as unknown as { drainApp(): Promise<void> }, 'drainApp').mockRejectedValue(new Error('synthetic lane failure'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await state.storage.deleteAlarm();
      await check(owner, state, () => logged.mock.calls.map(call => String(call[0])));
    } finally { drain.mockRestore(); logged.mockRestore(); await state.storage.deleteAlarm(); }
  });

it('a throw before any lane re-arms leaves a wake within the heartbeat period, and the platform still retries', async () => {
  await failingAlarm('alarm-fallback-retry', async (owner, state, lines) => {
    const before = Date.now();
    await expect(owner.alarm(attempt(0))).rejects.toThrow('synthetic lane failure');
    const armed = await state.storage.getAlarm();
    expect(armed).not.toBeNull();
    expect(armed!).toBeGreaterThanOrEqual(before + FALLBACK_MS);
    expect(armed!).toBeLessThanOrEqual(Date.now() + FALLBACK_MS);
    expect(lines()).toContain(JSON.stringify({ hop: 'alarm', ok: false, code: 'rethrown' }));
    expect(lines().join('\n')).not.toContain('synthetic lane failure');
  });
});

it('an earlier wake already armed stands; a past one is replaced', async () => {
  await failingAlarm('alarm-fallback-earlier', async (owner, state) => {
    const soon = Date.now() + 60_000;
    await armAlarm(state.storage, soon);
    await expect(owner.alarm(attempt(0))).rejects.toThrow();
    expect(await state.storage.getAlarm()).toBe(soon);

    await armAlarm(state.storage, Date.now() - 1_000);
    const before = Date.now();
    await expect(owner.alarm(attempt(1))).rejects.toThrow();
    expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + FALLBACK_MS);
  });
});

it('on the platform\'s last retry the handler returns, so the fallback wake is the one that stands', async () => {
  await failingAlarm('alarm-fallback-last', async (owner, state, lines) => {
    const before = Date.now();
    await expect(owner.alarm(attempt(6))).resolves.toBeUndefined();
    expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + FALLBACK_MS);
    expect(lines()).toContain(JSON.stringify({ hop: 'alarm', ok: false, code: 'fallback' }));
  });
});
