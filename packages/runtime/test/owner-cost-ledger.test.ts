import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { costLedger } from '../src/llm/cost-ledger';

const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');
type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown>; log(entry: TurnLogEntry): void; traces: { usage(at?: number): string } } }>;

it('the owner object ledgers every priced model call, and /usage shows the month by kind', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('owner-cost-ledger')), async (_instance, state) => {
    const owner = new TelegramOwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC' }) as unknown as Owner;
    const runtime = owner.setup('telegram');
    await runtime.ready;
    const usage = { model: WALDO_CHAT_MODEL, input: 12_000, output: 800, cached: 4_000 };
    runtime.log({ trace: 'tg-ledger-1', hop: 'llm_reply', ms: 900, ok: true, usage });
    runtime.log({ trace: 'card:brief:1', hop: 'llm_reply', ms: 300, ok: true, usage });
    const month = costLedger(state.storage.sql).monthByKind(Date.now());
    expect(month.reduce((sum, row) => sum + row.calls, 0)).toBe(2);
    expect(runtime.traces.usage()).toContain('This month: $');
  });
});
