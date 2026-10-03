import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { redactConversationEntries } from '../src/channels/conversation-store';
import { ownerCanonicalHistory } from '../src/channels/owner-canonical-history';

// Admitted-owner history is stored by ownerCanonicalHistory under canonical-owner-v1:<principal>:<tenant>: with
// conv:* rows AND witness:<id> copies of each entry. Forget must reach all of them.
const P = 'canonical-owner-v1:prn_x:ten_x:';
const entry = (id: string, text: string) => ({ id, ownerId: 'prn_x', modelPayload: text, appPayload: text, modelProjection: { mode: 'same' } });

describe('forget reaches the canonical owner history', () => {
  it('rewrites canonical conv rows and their witness copies', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical')), async (_i, state) => {
      const e = entry('e1', 'SYNTH: my zebra code word is plum');
      await state.storage.put({ [`${P}conv:0000000000`]: e, [`${P}witness:e1`]: { lineage: 'canonical_v1', principal_ref: 'prn_x', tenant_ref: 'ten_x', entry: e } });
      const receipt = await redactConversationEntries(state.storage, ['zebra code word', 'my zebra code word is plum'], '[forgotten]');
      const all = JSON.stringify([...(await state.storage.list({ prefix: P })).values()]);
      expect(all).not.toMatch(/zebra code word/i);
      expect(receipt.rewritten).toBeGreaterThan(0);
    });
  });
  it('counts what remains, and the canonical history still loads after a fenced redaction', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-load')), async (_i, state) => {
      const admission = { invocation: { verified_authority: { principal_ref: 'prn_x', tenant_ref: 'ten_x' } } };
      const adapter = { assertCurrent: async () => undefined, readCanonicalHistory: async (read: () => Promise<{ entries: { entry: unknown }[] }>) => (await read()).entries.map((row) => row.entry) };
      const history = ownerCanonicalHistory(state.storage, admission as never, adapter as never);
      const scope = { commit: (work: () => void) => work() };
      await history.save([entry('e1', 'SYNTH: my zebra code word is plum') as never, entry('e2', 'unrelated lunch plan') as never], 'e2', scope as never);
      const receipt = await redactConversationEntries(state.storage, ['zebra code word'], '[forgotten]', scope as never);
      expect(receipt).toEqual({ rewritten: 1, remaining: 0 });
      const loaded = await history.load();
      expect(loaded.entries.map((e) => (e as { modelPayload: string }).modelPayload).join(' ')).not.toMatch(/zebra code word/i);
      expect(loaded.entries.some((e) => (e as { modelPayload: string }).modelPayload === 'unrelated lunch plan')).toBe(true);
      // The same words stay countable when redaction is a no-op for a different needle.
      expect((await redactConversationEntries(state.storage, ['lunch'], '[forgotten]', scope as never)).rewritten).toBe(1);
    });
  });
  it('redacts more than 128 keys at once without hitting the storage put limit', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-many')), async (_i, state) => {
      const rows: Record<string, unknown> = {};
      for (let i = 0; i < 70; i += 1) {
        const e = entry(`e${i}`, `SYNTH ${i}: my zebra code word is plum`);
        rows[`${P}conv:${String(i).padStart(10, '0')}`] = e;
        rows[`${P}witness:e${i}`] = { lineage: 'canonical_v1', principal_ref: 'prn_x', tenant_ref: 'ten_x', entry: e };
      }
      for (const chunk of Object.entries(rows).reduce<Array<Record<string, unknown>>>((acc, kv, i) => { (acc[Math.floor(i / 100)] ??= {})[kv[0]] = kv[1]; return acc; }, [])) await state.storage.put(chunk);
      expect(await redactConversationEntries(state.storage, ['zebra code word'], '[forgotten]')).toEqual({ rewritten: 70, remaining: 0 });
    });
  });
  it('does not treat a legacy or foreign key that merely contains ":conv:" as canonical history', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-foreign')), async (_i, state) => {
      const e = entry('x1', 'my zebra code word is plum');
      await state.storage.put(`canonical-owner-v1:prn_x:ten_x:other:conv:0`, e);
      const receipt = await redactConversationEntries(state.storage, ['zebra code word'], '[forgotten]');
      expect(receipt.rewritten).toBe(0);
    });
  });
  it('writes every redacted canonical row in the same put as its witness', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical-pairs')), async (_i, state) => {
      const rows: Record<string, unknown> = {};
      for (let i = 0; i < 120; i += 1) {
        const e = entry(`p${i}`, `SYNTH ${i}: my zebra code word is plum`);
        rows[`${P}conv:${String(i).padStart(10, '0')}`] = e;
        rows[`${P}witness:p${i}`] = { lineage: 'canonical_v1', principal_ref: 'prn_x', tenant_ref: 'ten_x', entry: e };
      }
      await state.storage.put({ ...Object.fromEntries(Object.entries(rows).slice(0, 100)) });
      await state.storage.put({ ...Object.fromEntries(Object.entries(rows).slice(100, 200)) });
      await state.storage.put({ ...Object.fromEntries(Object.entries(rows).slice(200)) });
      const puts: string[][] = [];
      const proxy = new Proxy(state.storage, { get: (target, prop) => {
        if (prop === 'put') return async (v: Record<string, unknown>) => { puts.push(Object.keys(v)); return target.put(v); };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      await redactConversationEntries(proxy as never, ['zebra code word'], '[forgotten]');
      expect(puts.length).toBeGreaterThan(1);
      for (const keys of puts) {
        expect(keys.length).toBeLessThanOrEqual(100);
        for (const key of keys) if (key.includes(':conv:')) expect(keys).toContain(key.replace(':conv:' + key.split(':conv:')[1], ':witness:p' + Number(key.split(':conv:')[1])));
      }
    });
  });
});

describe('forget by source turn', () => {
  it('redacts the owner entry and the reply of a source turn whole, in conv rows and witnesses, and leaves other turns', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-source-turn-history')), async (_i, state) => {
      const rows = [entry('tg-1', 'I like the workshop early, nine sharp'), entry('tg-1-reply', 'Saved: mornings at 09:00.'), entry('tg-2', 'unrelated lunch plan')];
      const put: Record<string, unknown> = {};
      rows.forEach((e, i) => { put[`${P}conv:${String(i).padStart(10, '0')}`] = e; put[`${P}witness:${e.id}`] = { lineage: 'canonical_v1', principal_ref: 'prn_x', tenant_ref: 'ten_x', entry: e }; });
      await state.storage.put(put);
      const receipt = await redactConversationEntries(state.storage, [], '[forgotten]', undefined, ['tg-1']);
      expect(receipt.rewritten).toBe(2);
      const all = JSON.stringify([...(await state.storage.list({ prefix: P })).values()]);
      expect(all).not.toMatch(/nine sharp|09:00/);
      expect(all).toContain('unrelated lunch plan');
    });
  });
});

