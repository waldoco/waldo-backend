import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { episodeIndex, NIGHTLY_ID, NIGHTLY_THROUGH_KEY, ownerRows } from '../src/channels/episodes';
import { claimStore, turnMemoryPrompt } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

// Text the owner pastes inside a Telegram quote, or an audio file's transcript, is not the owner's own words: the nightly
// pass may learn from it, but never as an owner-grounded claim, as remember already refuses.
const OWN = 'my sister is called Mira. Look what Sam wrote:\n', QUOTE = 'I swim every Friday before work';
const CAPTION = 'my sister is called Mira. Listen to what Sam said.';
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
  const readers = { download: async () => new Uint8Array([1]), transcribe: async () => QUOTE };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[4] = readers; args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

it('splits an owner message into its own words and the quoted ranges, and quotes all of it when the ranges no longer fit', () => {
  const received = `${OWN}${QUOTE}`, ranges = [{ start: OWN.length, end: received.length }];
  expect(ownerRows(`${received}\n[photo]`, received, ranges)).toEqual([{ speaker: 'owner', text: OWN }, { speaker: 'quoted', text: QUOTE }, { speaker: 'quoted', text: '\n[photo]' }]);
  expect(ownerRows(`${CAPTION}\n[audio: ${QUOTE}]`, CAPTION, [])).toEqual([{ speaker: 'owner', text: CAPTION }, { speaker: 'quoted', text: `\n[audio: ${QUOTE}]` }]);
  expect(ownerRows(`[audio: ${QUOTE}]`, '', [])).toEqual([{ speaker: 'quoted', text: `[audio: ${QUOTE}]` }]);
  expect(ownerRows(received.replace('Mira', '[forgotten]'), received, ranges)).toEqual([{ speaker: 'quoted', text: received.replace('Mira', '[forgotten]') }]);
  expect(ownerRows(received, received, [{ start: 3, end: received.length + 1 }])).toEqual([{ speaker: 'quoted', text: received }]);
});

type Seed = Readonly<{ update?: Record<string, unknown>; earlier?: string }>;
// One message (or a row indexed before this owner's index split owner messages), then the nightly pass over it.
const consolidated = (name: string, seed: Seed, check: (rows: readonly (readonly [string, string])[], said: string | undefined, claim: (text: string) => readonly unknown[] | undefined, profile: string) => void) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const realNow = Date.now;
    let now = Date.parse('2026-10-13T05:00:00Z');
    Date.now = () => now;
    try {
      if (seed.earlier) episodeIndex(state.storage.sql).add('tg-before-split', 'owner', seed.earlier, now - 7_200_000);
      const build = () => new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' });
      const owner = build();
      state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
      if (seed.update) {
        const update = { update_id: 300, message: { message_id: 41, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, ...seed.update } };
        expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify(update) }))).status).toBe(200);
        for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
      } else await owner.alarm();
      const rows = episodeIndex(state.storage.sql).after(0, 100_000).filter(row => row.speaker !== 'waldo');

      state.storage.kv.put(NIGHTLY_THROUGH_KEY, now - 10_800_000);
      state.storage.sql.exec('DELETE FROM schedule');
      await new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: now - 1000, dueAt: now - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 0);
      // The night runs in a new owner object, as after an eviction, so the split time has to outlive the first one.
      await build().alarm();

      const claims = claimStore(state.storage.sql).claims();
      const claim = (text: string) => { const found = claims.find(candidate => candidate.text === text); return found && [found.origin, found.source, found.source_ref ?? null, found.verification_status]; };
      const prompt = turnMemoryPrompt(claimStore(state.storage.sql), 'tell me about me');
      check(rows.map(row => [row.speaker, row.text] as const), rows.find(row => row.speaker === 'owner')?.entry_id, claim, prompt.slice(prompt.indexOf('<owner_profile>'), prompt.indexOf('</owner_profile>')));
    } finally { Date.now = realNow; await state.storage.deleteAlarm(); }
  });
const UNTRUSTED = ['untrusted', 'inferred', null, 'provisional'];

it('a fact that sits in a Telegram quote never becomes an owner-grounded claim; the owner\'s own words beside it do', async () => {
  const text = `${OWN}${QUOTE}`;
  await consolidated('nightly-quoted', { update: { text, entities: [{ type: 'blockquote', offset: OWN.length, length: QUOTE.length }] } }, (rows, said, claim, profile) => {
    expect(rows).toEqual([['owner', OWN], ['quoted', QUOTE]]);
    expect(claim('Has a sister called Mira')).toEqual(['owner', 'stated', `owner, ${said}`, 'owner-grounded']);
    expect(claim('Swims every Friday before work')).toEqual(UNTRUSTED);
    expect(profile).toContain('Has a sister called Mira');
    expect(profile).not.toContain('Swims every Friday');
  });
}, 30_000);

it('what someone says in an audio file the owner sends is never the owner\'s words; the caption is', async () => {
  const audio = { file_id: 'synthetic-audio', file_name: 'sam.m4a', mime_type: 'audio/mp4', file_size: 1 };
  await consolidated('nightly-quoted-audio', { update: { caption: CAPTION, audio } }, (rows, said, claim, profile) => {
    expect(rows).toEqual([['owner', CAPTION], ['quoted', expect.stringContaining(`Transcript: ${QUOTE}`)]]);
    expect(rows[1]![1].startsWith('\n')).toBe(true);
    expect(claim('Has a sister called Mira')).toEqual(['owner', 'stated', `owner, ${said}`, 'owner-grounded']);
    expect(claim('Swims every Friday before work')).toEqual(UNTRUSTED);
    expect(profile).not.toContain('Swims every Friday');
  });
}, 30_000);

it('a whole message indexed before the split, inside the first night\'s window, grounds nothing as the owner\'s words', async () => {
  await consolidated('nightly-quoted-before-split', { earlier: `${OWN}${QUOTE}` }, (rows, _said, claim, profile) => {
    expect(rows).toEqual([['owner', `${OWN}${QUOTE}`]]);
    expect(claim('Has a sister called Mira')).toEqual(UNTRUSTED);
    expect(claim('Swims every Friday before work')).toEqual(UNTRUSTED);
    expect(profile).not.toContain('Swims every Friday');
    expect(profile).not.toContain('Has a sister called Mira');
  });
}, 30_000);
