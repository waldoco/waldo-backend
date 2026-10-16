import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';

const { OwnerDO } = await import('../src/channels/owner-do');

type Runtime = Readonly<{ owner: number; ready: Promise<unknown>; scheduler: object; finalOutbox: object; runs: object; reminders: object; traces: object; desk: object;
  act(action: Readonly<{ action: string; id: string; value?: string }>): Promise<boolean | string> }>;
type Owner = Readonly<{ setup(channel: string): Runtime; core: Readonly<{ scheduler: object; memory: object; effects: object }> | null; bindIdentity(headers: Headers): void }>;

// One owner object bound on Telegram (subject 7) and in the app, with no directory: both surfaces resolve locally.
const withOwner = (name: string, run: (owner: Owner) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('telegram_subject', '7');
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
    try { await run(owner); } finally { await state.storage.deleteAlarm(); }
  });

it('every surface of one owner object runs on one core: the same scheduler, outbox, run book, reminders and trace book', async () => {
  await withOwner('runtime-core-shared', async owner => {
    const telegram = owner.setup('telegram');
    await telegram.ready;
    const core = owner.core!;
    const app = owner.setup('app'), imessage = owner.setup('imessage');
    await app.ready; await imessage.ready;
    expect(owner.core).toBe(core);
    expect(telegram.scheduler).toBe(core.scheduler);
    for (const surface of [app, imessage]) {
      expect(surface).not.toBe(telegram);
      expect(surface.scheduler).toBe(telegram.scheduler);
      expect(surface.finalOutbox).toBe(telegram.finalOutbox);
      expect(surface.runs).toBe(telegram.runs);
      expect(surface.reminders).toBe(telegram.reminders);
      expect(surface.traces).toBe(telegram.traces);
    }
    // Each surface still decides on its own desk over the one ledger.
    expect(app.desk).not.toBe(telegram.desk);
    expect(owner.setup('telegram')).toBe(telegram);
  });
});

it('an identity change rebuilds the core and every surface, while a runtime already handed out keeps its own objects', async () => {
  await withOwner('runtime-core-rebind', async owner => {
    const before = owner.setup('telegram'), appBefore = owner.setup('app');
    await before.ready; await appBefore.ready;
    const core = owner.core!;
    owner.bindIdentity(new Headers({ 'x-waldo-telegram-subject': '8' }));
    expect(owner.core).toBeNull();
    const after = owner.setup('telegram'), appAfter = owner.setup('app');
    await after.ready; await appAfter.ready;
    expect(after.owner).toBe(8);
    expect(before.owner).toBe(7);
    expect(owner.core).not.toBe(core);
    expect(after.scheduler).not.toBe(before.scheduler);
    expect(appAfter).not.toBe(appBefore);
    expect(appAfter.scheduler).toBe(after.scheduler);
    expect(before.scheduler).toBe(core.scheduler);
  });
});

it('a time-zone change from the console rebuilds the core so values captured at build time follow the new zone', async () => {
  await withOwner('runtime-core-zone', async owner => {
    const before = owner.setup('telegram');
    await before.ready;
    const core = owner.core!;
    expect(await before.act({ action: 'timezone.set', id: '', value: 'Europe/Berlin' })).toBe(true);
    const after = owner.setup('telegram');
    expect(after).not.toBe(before);
    expect(owner.core).not.toBe(core);
    expect(after.scheduler).toBe(owner.core!.scheduler);
  });
});
