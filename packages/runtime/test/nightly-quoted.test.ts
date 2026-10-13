import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { episodeIndex, NIGHTLY_ID, NIGHTLY_THROUGH_KEY, ownerRows } from '../src/channels/episodes';
import { claimStore, turnMemoryPrompt } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

// Text the owner pastes inside a Telegram quote is not the owner's own words: the nightly pass may learn from it, but
// never as an owner-grounded claim, as remember already refuses.
const OWN = 'my sister is called Mira. Look what Sam wrote:\n', QUOTE = 'I swim every Friday before work';
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => method === 'sendMessage' ? { message_id: 900, chat: { id: payload.chat_id } } : true };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete({ request }) {
    const said = JSON.stringify(request.messages);
    const add = request.response_format?.name !== 'claim_ops' ? [] : [['Has a sister called Mira', 'my sister is called Mira'], ['Swims every Friday before work', QUOTE]]
      .filter(([, quote]) => said.includes(quote!)).map(([text, quote]) => ({ kind: 'fact', text, source: 'stated', evidence: `"${quote}"`, touches_forgotten: false, aliases: [], aliases_touch_forgotten: false }));
    const text = request.response_format?.name === 'claim_ops' ? JSON.stringify({ add, corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null })
      : request.response_format ? '{}' : 'Noted.';
    return { ok: true, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

it('splits an owner message into its own words and the quoted ranges, and quotes all of it when the ranges no longer fit', () => {
  const received = `${OWN}${QUOTE}`, ranges = [{ start: OWN.length, end: received.length }];
  expect(ownerRows(`${received}\n[photo]`, received, ranges)).toEqual([{ speaker: 'owner', text: OWN }, { speaker: 'quoted', text: QUOTE }, { speaker: 'owner', text: '\n[photo]' }]);
  expect(ownerRows(received.replace('Mira', '[forgotten]'), received, ranges)).toEqual([{ speaker: 'quoted', text: received.replace('Mira', '[forgotten]') }]);
  expect(ownerRows(received, received, [{ start: 3, end: received.length + 1 }])).toEqual([{ speaker: 'quoted', text: received }]);
});

it('a fact that sits in a Telegram quote never becomes an owner-grounded claim; the owner\'s own words beside it do', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('nightly-quoted')), async (_instance, state) => {
    const realNow = Date.now;
    let now = Date.parse('2026-10-13T05:00:00Z');
    Date.now = () => now;
    try {
      const owner = new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' });
      state.storage.kv.put('do_name', 'nightly-quoted'); state.storage.kv.put('telegram_subject', '7');
      const text = `${OWN}${QUOTE}`;
      const update = { update_id: 300, message: { message_id: 41, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text, entities: [{ type: 'blockquote', offset: OWN.length, length: QUOTE.length }] } };
      expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify(update) }))).status).toBe(200);
      for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }

      const rows = episodeIndex(state.storage.sql).after(0, 100_000).filter(row => row.speaker !== 'waldo');
      expect(rows.map(row => [row.speaker, row.text])).toEqual([['owner', OWN], ['quoted', QUOTE]]);
      const said = rows[0]!.entry_id;

      state.storage.kv.put(NIGHTLY_THROUGH_KEY, now - 3_600_000);
      state.storage.sql.exec('DELETE FROM schedule');
      await new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: now - 1000, dueAt: now - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 0);
      await owner.alarm();

      const claims = claimStore(state.storage.sql).claims();
      const mira = claims.find(claim => claim.text === 'Has a sister called Mira')!, swims = claims.find(claim => claim.text === 'Swims every Friday before work');
      expect([mira.source_ref, mira.verification_status]).toEqual([`owner, ${said}`, 'owner-grounded']);
      expect(swims && [swims.origin, swims.source, swims.source_ref ?? null, swims.verification_status]).toEqual(['untrusted', 'inferred', null, 'provisional']);
      const profile = turnMemoryPrompt(claimStore(state.storage.sql), 'tell me about me');
      expect(profile.slice(profile.indexOf('<owner_profile>'), profile.indexOf('</owner_profile>'))).not.toContain('Swims every Friday');
    } finally { Date.now = realNow; await state.storage.deleteAlarm(); }
  });
}, 30_000);
