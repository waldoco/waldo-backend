// This integration test reaches the real webhook router, per-owner Durable Objects,
// listener, and model responder. All external model and Telegram effects are intercepted.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerDirectory, OwnerRoute } from '../src/identity/owner-directory';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { IsolatedSourceWorld } from '../scenarios/isolated-source-world';
import { isolatedCalendarEffectClient, isolatedGoogleClient } from '../scenarios/isolated-google-client';
import { captureFixtureAdapters } from '../evals/fixture-adapter-capture';
import { auditIsolatedWorld } from '../evals/isolated-world-audit';
import type { NativeManifest } from '../evals/native-manifest';

const outbox: { method: string; body: Record<string, unknown> }[] = [];
const modelInputs: unknown[] = [];
const unexpectedFetches: string[] = [];
let sourceWorld: IsolatedSourceWorld | null = null;
let interceptCalendarEffects = false;
vi.mock('../src/seams/deps', async (load) => {
  const original = await load<typeof import('../src/seams/deps')>();
  return { ...original, productionDeps: () => {
    const deps = original.productionDeps();
    return { ...deps, now: () => sourceWorld ? Date.parse(sourceWorld.now()) : deps.now() };
  } };
});
vi.mock('../src/connectors/google', async (load) => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, tokens: { email?: string }) => {
    if (!sourceWorld || !tokens.email) throw new Error('fixture Google account is unavailable');
    return interceptCalendarEffects ? isolatedCalendarEffectClient(sourceWorld, tokens.email) : isolatedGoogleClient(sourceWorld, tokens.email);
  } };
});
vi.mock('../src/channels/telegram-api', async (load) => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return {
    ...original,
    createTelegramCaller: () => async (method: string, body: object) => {
      outbox.push({ method, body: body as Record<string, unknown> });
      return method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: outbox.length, chat: { id: (body as {chat_id?: number}).chat_id } } : true;
    },
  };
});
vi.mock('openai', () => ({
  default: class {
    responses = { create: async (body: unknown) => {
      modelInputs.push(body);
      const name = (body as { text?: { format?: { name?: string } } }).text?.format?.name;
      const text = name === 'claim_ops'
        ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
        : 'Synthetic answer from the model adapter.';
      const input = JSON.stringify(body);
      const wantsMail = input.includes('Read the fixture inbox');
      const wantsProposal = input.includes('Propose a fixture calendar event') && !input.includes('REPLY_FIXTURE_TARGET');
      const hasToolOutput = input.includes('function_call_output');
      const output = name === 'claim_ops' || hasToolOutput ? []
        : wantsProposal ? [{ type: 'function_call', call_id: 'fixture-calendar-proposal', name: 'propose_calendar_change', arguments: JSON.stringify({ action: 'create', title: 'Fixture meeting', start: '2026-10-01T10:00:00+05:30', end: '2026-10-01T10:30:00+05:30', reason: 'test-only owner request' }) }]
        : wantsMail ? [{ type: 'function_call', call_id: 'fixture-mail-read', name: 'get_communication', arguments: '{}' }]
        : [];
      return { id: `fixture-${modelInputs.length}`, output_text: output.length ? '' : text, output, usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
    } };
  },
}));

const { handleTelegramWebhook } = await import('../src/channels/telegram-webhook');
let sequence = 0;
const route = (subject: number): OwnerRoute => ({ doName: `hermetic-owner-${subject}`, subject: String(subject), timezone: 'Asia/Kolkata' });
const directory: OwnerDirectory = { byPresence: async (provider, subject) => provider === 'telegram' && ['81101', '81102'].includes(subject) ? route(Number(subject)) : null, redeem: async () => null };
const send = async (subject: number, text: string, updateId: number, replyTo?: Record<string, unknown>) => {
  const pending: Promise<unknown>[] = [];
  const response = await handleTelegramWebhook(new Request('https://fixture.invalid/telegram/webhook', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'hermetic-test-webhook-secret' },
    body: JSON.stringify({ update_id: updateId, message: { message_id: updateId, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, text, ...(replyTo ? { reply_to_message: replyTo } : {}) } }),
  }), env, (work) => pending.push(work), directory);
  await Promise.all(pending);
  await runInDurableObject(doStub(subject), async (instance, state) => {
    await instance.alarm();
    const rows = state.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1') ?? [];
    for (const row of rows) if (row.status === 'pending') row.dueAt = 0;
    state.storage.kv.put('telegram_final_outbox_v1', rows);
    await instance.alarm();
  });
  return response;
};
const callback = async (subject: number, from: number, data: string, updateId: number) => {
  const pending: Promise<unknown>[] = [];
  const response = await handleTelegramWebhook(new Request('https://fixture.invalid/telegram/webhook', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'hermetic-test-webhook-secret' },
    body: JSON.stringify({ update_id: updateId, callback_query: { id: `fixture-query-${updateId}`, from: { id: from, is_bot: false }, data, message: { message_id: updateId, chat: { id: subject, type: 'private' } } } }),
  }), env, (work) => pending.push(work), directory);
  await Promise.all(pending);
  await runInDurableObject(doStub(subject), async instance => { await instance.alarm(); });
  return response;
};
const doStub = (subject: number) => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(route(subject).doName)) as DurableObjectStub<TelegramOwnerDO>;

describe('real owner-DO ingress in a sealed test world', () => {
  beforeEach(() => {
    unexpectedFetches.length = 0;
    // Hard deny all ordinary global network calls in this integration harness. The
    // only legal effects are the explicit mocked model/channel and fixture adapter.
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      unexpectedFetches.push(String(input));
      throw new Error('isolated trial attempted an unmocked outbound fetch');
    }) as typeof fetch);
  });
  afterEach(() => {
    sourceWorld = null; interceptCalendarEffects = false;
    vi.unstubAllGlobals();
    expect(unexpectedFetches).toEqual([]);
  });
  it('records and denies an unexpected outbound fetch rather than reaching a network', async () => {
    await expect(fetch('https://unlisted.fixture.invalid/private')).rejects.toThrow(/unmocked outbound fetch/);
    expect(unexpectedFetches).toEqual(['https://unlisted.fixture.invalid/private']);
    // This negative test intentionally made one denied call; the teardown checks zero
    // unexpected calls on every actual owner-DO trial below.
    unexpectedFetches.length = 0;
  });
  it('routes two fictional owners through separate durable state and intercepts model and channel effects', async () => {
    outbox.length = 0;
    modelInputs.length = 0;
    const update = 100000 + ++sequence * 10;
    expect((await send(81101, 'My private fixture is cedar.', update)).status).toBe(200);
    expect((await send(81102, 'My private fixture is birch.', update + 1)).status).toBe(200);
    const answers = outbox.filter((item) => item.method === 'sendMessage');
    expect(answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: expect.objectContaining({ chat_id: 81101, text: 'Synthetic answer from the model adapter.' }) }),
      expect.objectContaining({ body: expect.objectContaining({ chat_id: 81102, text: 'Synthetic answer from the model adapter.' }) }),
    ]));
    const replyInputs = modelInputs.filter((input) => JSON.stringify(input).includes('My private fixture is'))
      .map((input) => JSON.stringify(input));
    expect(replyInputs).toEqual(expect.arrayContaining([expect.stringContaining('cedar'), expect.stringContaining('birch')]));
    expect(replyInputs.filter((input) => input.includes('cedar')).every((input) => !input.includes('birch'))).toBe(true);
    expect(replyInputs.filter((input) => input.includes('birch')).every((input) => !input.includes('cedar'))).toBe(true);
    expect(outbox.every((item) => item.method === 'setWebhook' || [81101, 81102].includes(Number(item.body.chat_id)))).toBe(true);
    const before = outbox.length;
    expect((await send(81101, 'My private fixture is cedar.', update)).status).toBe(200);
    expect(outbox.length).toBe(before); // duplicate ingress cannot re-send effects
    await runInDurableObject(doStub(81101), async (_instance, state) => {
      expect(state.storage.kv.get('telegram_subject')).toBe('81101');
    });
    await runInDurableObject(doStub(81102), async (_instance, state) => {
      expect(state.storage.kv.get('telegram_subject')).toBe('81102');
    });
  });
  it('routes fictional Google reads through owner-scoped source rows inside the real DO tool loop', async () => {
    sourceWorld = new IsolatedSourceWorld({ clock: '2026-09-29T11:00:00Z', owners: [{ id: 'a@example.invalid' }, { id: 'b@example.invalid' }], sources: { mail: [
      { owner_id: 'a@example.invalid', id: 'mail', thread_id: 'thread', from: 'sender@example.invalid', subject: 'Cedar report', snippet: 'cedar only', at: '2026-09-29T10:30:00Z' },
      { owner_id: 'b@example.invalid', id: 'mail', thread_id: 'thread', from: 'sender@example.invalid', subject: 'Birch report', snippet: 'birch only', at: '2026-09-29T10:30:00Z' },
    ] } });
    outbox.length = 0; modelInputs.length = 0;
    for (const [subject, email] of [[81101, 'a@example.invalid'], [81102, 'b@example.invalid']] as const) {
      await runInDurableObject(doStub(subject), async (_instance, state) => {
        await state.storage.put('google:accounts', [{ id: `local:${email}`, email, scopes: null, refresh_token: 'fictional-not-a-token' }]);
      });
    }
    const update = 200000 + ++sequence * 10;
    expect((await send(81101, 'Read the fixture inbox for owner A.', update)).status).toBe(200);
    sourceWorld.advance('2026-09-29T11:01:00Z');
    expect((await send(81102, 'Read the fixture inbox for owner B.', update + 1)).status).toBe(200);
    const sent = outbox.filter((item) => item.method === 'sendMessage');
    expect(sent.map((item) => item.body.chat_id)).toEqual([81101, 81102]);
    const toolInputs = modelInputs.filter((body) => JSON.stringify(body).includes('function_call_output')).map((body) => JSON.stringify(body));
    expect(toolInputs).toEqual(expect.arrayContaining([expect.stringContaining('cedar only'), expect.stringContaining('birch only')]));
    expect(toolInputs.filter((input) => input.includes('cedar only')).every((input) => !input.includes('birch only'))).toBe(true);
    expect(toolInputs.filter((input) => input.includes('birch only')).every((input) => !input.includes('cedar only'))).toBe(true);
    // Capture collection-boundary evidence from the source adapter and real owner DO.
    // This is a scripted-model smoke, not a scored W/R trial.
    const aAccess = sourceWorld.accessLog('a@example.invalid');
    const bAccess = sourceWorld.accessLog('b@example.invalid');
    expect(aAccess).toEqual([expect.objectContaining({ owner_id: 'a@example.invalid', source: 'mail', kind: 'list' })]);
    expect(bAccess).toEqual([expect.objectContaining({ owner_id: 'b@example.invalid', source: 'mail', kind: 'list' })]);
    expect(sourceWorld.outbox('a@example.invalid')).toEqual([]);
    expect(sourceWorld.outbox('b@example.invalid')).toEqual([]);
    for (const [subject, ownWord, otherWord] of [[81101, 'cedar only', 'birch only'], [81102, 'birch only', 'cedar only']] as const) {
      await runInDurableObject(doStub(subject), async (_instance, state) => {
        const rows = state.storage.sql.exec<{ trace: string; hop: string; owner: string | null }>(
          'SELECT trace, hop, owner FROM trace_log WHERE trace = ? ORDER BY id', `tg-${update + (subject === 81101 ? 0 : 1)}`).toArray();
        expect(rows.some((row) => row.hop === 'tool_get_communication')).toBe(true);
        expect(rows.some((row) => row.hop === 'turn')).toBe(true);
        expect(rows.every((row) => row.owner !== null)).toBe(true);
        const times = state.storage.sql.exec<{ at: number }>('SELECT at FROM trace_log WHERE trace = ?',
          `tg-${update + (subject === 81101 ? 0 : 1)}`).toArray();
        expect(times.length).toBeGreaterThan(0);
        expect(times.every((row) => row.at === Date.parse(subject === 81101 ? '2026-09-29T11:00:00Z' : '2026-09-29T11:01:00Z'))).toBe(true);
      });
      expect(toolInputs.some((input) => input.includes(ownWord) && !input.includes(otherWord))).toBe(true);
    }
  });
  it('routes an owner-scoped calendar proposal card through the real DO without applying a provider effect', async () => {
    // Proposal-time route custody now resolves a real fixture account before issuing a card.
    // Do not rely on the previous test's account while leaving its source adapter unset.
    sourceWorld = new IsolatedSourceWorld({ clock: '2026-09-29T11:00:00Z', owners: [{ id: 'a@example.invalid' }], sources: {} });
    await runInDurableObject(doStub(81101), async (_instance, state) => {
      await state.storage.put('google:accounts', [{ id: 'local:a@example.invalid', email: 'a@example.invalid', scopes: null, refresh_token: 'fictional-not-a-token' }]);
    });
    outbox.length = 0; modelInputs.length = 0;
    const update = 300000 + ++sequence * 10;
    expect((await send(81101, 'Propose a fixture calendar event, but do not commit it.', update)).status).toBe(200);
    const cards = outbox.filter((item) => item.method === 'sendMessage' && String(item.body.text).startsWith('Proposed:'));
    expect(sourceWorld.outbox('a@example.invalid')).toEqual([]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.body.chat_id).toBe(81101);
    expect(JSON.stringify(cards[0]!.body.reply_markup)).toContain('Do it');
    const proposalOutput = modelInputs.map((body) => JSON.stringify(body)).find((input) => input.includes('function_call_output') && input.includes('proposal_id'));
    expect(proposalOutput).toContain('applied');
    expect(proposalOutput).toContain('false');
    const card = cards[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    const approve = card.inline_keyboard.flat().find((button) => button.callback_data.startsWith('a:'))!.callback_data;
    const skip = card.inline_keyboard.flat().find((button) => button.callback_data.startsWith('s:'))!.callback_data;
    const ledgerState = async () => runInDurableObject(doStub(81101), async (_instance, state) =>
      state.storage.sql.exec<{ kind: string; status: string }>('SELECT kind, status FROM ledger WHERE kind = ? ORDER BY created_at DESC LIMIT 1', 'calendar_change').toArray());
    expect(await ledgerState()).toEqual([{ kind: 'calendar_change', status: 'open' }]);
    // Real reply_to_message ingress while a proposal is open. The model is scripted:
    // this proves context plumbing and unchanged task state, not interpretation quality.
    modelInputs.length = 0;
    const quote = 'REPLY_FIXTURE_TARGET: waiting for review on the fixture meeting';
    expect((await send(81101, '?', update + 1, {
      message_id: update, date: 1, from: { id: 99123, is_bot: true },
      chat: { id: 81101, type: 'private' }, text: quote,
    })).status).toBe(200);
    const replyInput = modelInputs.find((body) => JSON.stringify(body).includes(quote));
    expect(replyInput).toBeDefined();
    expect(JSON.stringify(replyInput)).toContain('observed_author_id');
    expect(JSON.stringify(replyInput)).toContain('99123');
    expect(JSON.stringify(replyInput)).toContain('external quoted data');
    expect(modelInputs.filter((body) => JSON.stringify(body).includes('claim_ops'))
      .every((body) => !JSON.stringify(body).includes(quote))).toBe(true);
    expect(await ledgerState()).toEqual([{ kind: 'calendar_change', status: 'open' }]);
    expect(sourceWorld.outbox('a@example.invalid')).toEqual([]);
    // First try the forged sender on A's DO directly: this exercises the approval
    // desk's owner check, not only the webhook directory's normal routing.
    await doStub(81101).fetch('https://telegram-owner/turn', { method: 'POST', headers: { 'x-waldo-telegram-subject': '81101' },
        body: JSON.stringify({ update_id: update + 2, callback_query: { id: `fixture-forgery-${update}`, from: { id: 81102 }, data: approve, message: { message_id: update, chat: { id: 81101 } } } }) });
    expect(await ledgerState()).toEqual([{ kind: 'calendar_change', status: 'open' }]);
    expect(outbox.some((item) => item.method === 'answerCallbackQuery' && item.body.callback_query_id === `fixture-forgery-${update}` && item.body.text === 'Not available.')).toBe(true);
    expect((await callback(81101, 81101, skip, update + 3)).status).toBe(200);
    expect(await ledgerState()).toEqual([{ kind: 'calendar_change', status: 'skipped' }]);
    expect((await callback(81101, 81101, approve, update + 4)).status).toBe(200);
    expect(await ledgerState()).toEqual([{ kind: 'calendar_change', status: 'skipped' }]);
    expect(outbox.some((item) => item.method === 'answerCallbackQuery' && item.body.callback_query_id === `fixture-query-${update + 4}` && item.body.text === 'Already handled.')).toBe(true);
    expect((await send(81101, 'Propose a fixture calendar event, but do not commit it.', update)).status).toBe(200);
    expect(outbox.filter((item) => item.method === 'sendMessage' && String(item.body.text).startsWith('Proposed:'))).toHaveLength(1);
  });
  it('intercepts a calendar provider write only after the bound owner approves the card', async () => {
    sourceWorld = new IsolatedSourceWorld({ clock: '2026-09-29T13:00:00Z', owners: [{ id: 'a@example.invalid' }, { id: 'b@example.invalid' }], sources: {} });
    interceptCalendarEffects = true; outbox.length = 0; modelInputs.length = 0;
    const update = 400000 + ++sequence * 10;
    expect((await send(81101, 'Propose a fixture calendar event for my review.', update)).status).toBe(200);
    const card = outbox.find((item) => item.method === 'sendMessage' && String(item.body.text).startsWith('Proposed:'))!.body;
    const keyboard = card.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    const approve = keyboard.inline_keyboard.flat().find((button) => button.callback_data.startsWith('a:'))!.callback_data;
    expect(sourceWorld.outbox('a@example.invalid')).toEqual([]);
    expect(sourceWorld.outbox('b@example.invalid')).toEqual([]);
    expect((await callback(81101, 81101, approve, update + 1)).status).toBe(200);
    expect(sourceWorld.outbox('a@example.invalid')).toEqual([expect.objectContaining({ kind: 'calendar.create', target: 'primary', payload: { title: 'Fixture meeting', start: '2026-10-01T10:00:00+05:30', end: '2026-10-01T10:30:00+05:30' } })]);
    expect(sourceWorld.outbox('b@example.invalid')).toEqual([]);
    expect(sourceWorld.providerCalendarReadback('a@example.invalid')).toEqual([expect.objectContaining({ title: 'Fixture meeting', start: '2026-10-01T10:00:00+05:30' })]);
    expect(sourceWorld.providerCalendarReadback('b@example.invalid')).toEqual([]);
    await runInDurableObject(doStub(81101), async (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM ledger WHERE kind = 'calendar_change' AND status = 'done' ORDER BY rowid DESC LIMIT 1").toArray()).toEqual([{ status: 'done' }]);
    });
    expect((await callback(81101, 81101, approve, update + 2)).status).toBe(200);
    expect(sourceWorld.outbox('a@example.invalid')).toHaveLength(1);
    expect(sourceWorld.providerCalendarReadback('a@example.invalid')).toHaveLength(1);
    // Compare the actual fictional DO approval against the same fixture clock.
    const fixture: NativeManifest = {
      case_id: 'W01', candidate_owner: 'a@example.invalid', control_owner: 'b@example.invalid',
      visible_prompt: 'scripted fixture approval',
      world: { clock: '2026-09-29T13:00:00Z', owners: [{ id: 'a@example.invalid' }, { id: 'b@example.invalid' }], sources: {} },
      grants: [{ owner_id: 'a@example.invalid', purpose: 'fictional calendar-create approval', scope: 'one fixture event',
        allowed_effects: ['calendar.create'], effective_at: '2026-09-29T13:00:00Z', expires_at: '2026-09-29T13:30:00Z' }],
      branches: [{ id: 'approved', owner_id: 'a@example.invalid', trigger_at: '2026-09-29T13:00:00Z', permitted_effects: ['calendar.create'] }],
      supported_tools: ['calendar.create'], source_digest: 'not-a-native-manifest',
    };
    const evidence = { candidate_effects: sourceWorld.outbox('a@example.invalid'), control_effects: sourceWorld.outbox('b@example.invalid'),
      candidate_calendar: sourceWorld.providerCalendarReadback('a@example.invalid'), control_calendar: sourceWorld.providerCalendarReadback('b@example.invalid') };
    const captured = captureFixtureAdapters(sourceWorld, { case_id: 'fictional-smoke', seed: String(update),
      candidate_owner: 'a@example.invalid', control_owner: 'b@example.invalid' },
      { source_adapter: 'fixture-source-key', effect_interceptor: 'fixture-effect-key', provider_readback: 'fixture-provider-key' });
    expect(JSON.parse(captured.artifacts.intercepted_effects.bytes).data).toEqual(evidence.candidate_effects);
    expect(JSON.parse(captured.artifacts.final_state_readback.bytes).data.calendar).toEqual(evidence.candidate_calendar);
    expect(captured.receipts).toHaveLength(3);
    expect(auditIsolatedWorld(fixture, evidence).status).toBe('consistent_fixture');
    expect(auditIsolatedWorld({ ...fixture, grants: [] }, evidence).errors).toContain('effect outside synthetic grant and branch');
  });
});

it('transport persistence transaction commits final and alarm together, rollback keeps neither', async () => {
  const { persistTransportWake, armAlarm } = await import('../src/scheduler/alarm-slot');
  await runInDurableObject(doStub(81101), async (_instance, state) => {
    const previous = await state.storage.getAlarm();
    const due = Date.now() + 10000;
    await persistTransportWake(state.storage, [], due);
    expect(state.storage.kv.get('telegram_final_outbox_due_v1')).toBe(due);
    expect(await state.storage.getAlarm()).not.toBeNull();
    await expect(state.storage.transaction(async txn => {
      await txn.put({ telegram_final_outbox_v1: [{ id: 'cut' }], telegram_final_outbox_due_v1: 999 });
      await armAlarm(txn, Date.now() + 100000);
      throw new Error('crash before commit');
    })).rejects.toThrow('crash before commit');
    expect(state.storage.kv.get('telegram_final_outbox_v1')).toEqual([]);
    expect(state.storage.kv.get('telegram_final_outbox_due_v1')).toBe(due);
    if (previous === null) await state.storage.deleteAlarm();
  });
});

it('due transport backlog yields every second alarm to due scheduled work', async () => {
  const { ensureSchema } = await import('../src/tracer/schema');
  const { Scheduler } = await import('../src/scheduler/multiplexer');
  const { productionDeps } = await import('../src/seams/deps');
  await runInDurableObject(doStub(81101), async (instance, state) => {
    ensureSchema(state.storage);
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    await scheduler.schedule({ id: 'fair-reminder', kind: 'reminder', dueAt: Date.now() - 100, occurrenceAt: Date.now() - 100, payloadRefs: { reminder_id: 'fair-reminder' } });
    // A missing note still reaches the executor and settles its scheduler run.
    const records = [1, 2].map(i => ({ id: `fair-${i}`, trace: `fair-${i}`, payload: { chat_id: 81101, text: 'fixture' }, digest: 'fixture',
      ownerSubject: '81101', doName: state.storage.kv.get('do_name') ?? '', status: 'pending', dueAt: 0, createdAt: Date.now(), attempts: 0 }));
    state.storage.kv.put('telegram_final_outbox_v1', records); state.storage.kv.put('telegram_final_outbox_due_v1', 0);
    state.storage.kv.put('transport_last_alarm', false);
    await instance.alarm();
    expect(scheduler.read('fair-reminder')).not.toBeNull();
    await instance.alarm();
    expect(scheduler.read('fair-reminder')).toBeNull();
    expect((state.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1') ?? []).filter(r => r.status === 'pending')).toHaveLength(1);
  });
});

it('crash after reminder final enqueue before schedule complete never repeats the model executor', async () => {
  const { Scheduler } = await import('../src/scheduler/multiplexer');
  const { productionDeps } = await import('../src/seams/deps');
  const { TelegramFinalOutbox } = await import('../src/channels/telegram-final-outbox');
  await runInDurableObject(doStub(81102), async (_instance, state) => {
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    const occurrence = Date.now() - 1000;
    await scheduler.schedule({ id: 'cut-reminder', kind: 'reminder', dueAt: occurrence, occurrenceAt: occurrence, payloadRefs: { reminder_id: 'cut-reminder' } });
    const queue = new TelegramFinalOutbox(state.storage.kv);
    let modelCalls = 0;
    await expect(scheduler.dispatchDue({ reminder: async entry => {
      modelCalls++;
      await queue.enqueue({ id: `cut:${entry.id}:${entry.occurrence_at}`, trace: 'cut', payload: { chat_id: 81102, text: 'frozen' }, ownerSubject: '81102', doName: '', reminder: { id: entry.id, occurrence: entry.occurrence_at, runId: 'fixture', schedulerRunId: scheduler.runningRunId(entry.id, entry.occurrence_at), once: true } });
      const error = new Error('crash-injection: after enqueue'); error.name = 'CrashInjectionError'; throw error;
    } })).rejects.toThrow('crash-injection: after enqueue');
    await scheduler.dispatchDue({ reminder: async () => { modelCalls++; } });
    expect(modelCalls).toBe(1); expect(queue.records().filter(r => r.id.startsWith('cut:'))).toHaveLength(1);
    expect(scheduler.read('cut-reminder')).toBeNull();
    const history = state.storage.sql.exec<{ id: string; outcome: string }>('SELECT id, outcome FROM schedule_runs WHERE schedule_id = ?', 'cut-reminder').toArray();
    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe('running');
    const final = queue.records().find(r => r.id.startsWith('cut:'))!;
    scheduler.settleDelivery(final.reminder!.schedulerRunId!, true);
    const settled = state.storage.sql.exec<{ outcome: string; delivery: string }>('SELECT outcome, delivery FROM schedule_runs WHERE schedule_id = ?', 'cut-reminder').toArray();
    expect(settled).toEqual([{ outcome: 'ok', delivery: 'sent' }]);
  });
});

it('rejects route/body mismatch before rebind or effects, and deliberately ignores unsupported groups', async () => {
  const subject = 81101; const stub = doStub(subject); const before = modelInputs.length;
  const headers = { 'x-waldo-inbox-secret': 'hermetic-test-webhook-secret', 'x-waldo-telegram-subject': String(subject), 'x-waldo-do-name': route(subject).doName };
  expect((await stub.fetch('https://telegram-owner/enqueue', { method:'POST', headers, body:JSON.stringify({update_id:888801,message:{from:{id:81102},chat:{id:81102,type:'private'},text:'wrong owner'}}) })).status).toBe(403);
  expect((await stub.fetch('https://telegram-owner/enqueue', { method:'POST', headers, body:JSON.stringify({update_id:888802,message:{from:{id:subject},chat:{id:subject,type:'group'},text:'group content'}}) })).status).toBe(200);
  expect(modelInputs).toHaveLength(before);
  await runInDurableObject(stub, async (_instance,state) => { expect(state.storage.kv.get<string>('telegram_subject')).not.toBe('81102'); });
});

it('executes high then lower admitted update without swallowing either, and dedupes redelivery', async () => {
  const subject = 81102; const stub = doStub(subject); const headers = { 'x-waldo-inbox-secret':'hermetic-test-webhook-secret', 'x-waldo-telegram-subject':String(subject), 'x-waldo-do-name':route(subject).doName };
  const body = (id:number,text:string) => JSON.stringify({update_id:id,message:{message_id:id,from:{id:subject,is_bot:false},chat:{id:subject,type:'private'},text}});
  const high = body(990020,'HIGH_ADMITTED_FIXTURE'); const low = body(990002,'LOW_ADMITTED_FIXTURE'); modelInputs.length=0;
  expect((await stub.fetch('https://telegram-owner/enqueue',{method:'POST',headers,body:high})).status).toBe(200);
  expect((await stub.fetch('https://telegram-owner/enqueue',{method:'POST',headers,body:low})).status).toBe(200);
  await runInDurableObject(stub, async(instance,state) => { for(let n=0;n<6;n++){ const finals=state.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')??[]; for(const final of finals)if(final.status==='pending')final.dueAt=0;state.storage.kv.put('telegram_final_outbox_v1',finals);await instance.alarm(); }
    const rows=await state.storage.get<import('../src/channels/telegram-owner-inbox').InboxRecord[]>('telegram_owner_inbox_v1');
    expect(rows?.find(r=>r.updateId===990020)?.state).toBe('completed'); expect(rows?.find(r=>r.updateId===990002)?.state).toBe('completed');
  });
  const before=modelInputs.length; expect((await stub.fetch('https://telegram-owner/enqueue',{method:'POST',headers,body:low})).status).toBe(200);
  await runInDurableObject(stub, async instance=>{await instance.alarm();}); expect(modelInputs).toHaveLength(before);
  expect(modelInputs.some(input=>JSON.stringify(input).includes('LOW_ADMITTED_FIXTURE'))).toBe(true);
});

it('three ready classes each progress within three alarms', async () => {
  const { Scheduler } = await import('../src/scheduler/multiplexer'); const { productionDeps } = await import('../src/seams/deps');
  const subject=81101;const stub=doStub(subject); const headers={'x-waldo-inbox-secret':'hermetic-test-webhook-secret','x-waldo-telegram-subject':String(subject),'x-waldo-do-name':route(subject).doName};
  await stub.fetch('https://telegram-owner/enqueue',{method:'POST',headers,body:JSON.stringify({update_id:998877,message:{message_id:998877,from:{id:subject,is_bot:false},chat:{id:subject,type:'private'},text:'FAIR_INBOX_FIXTURE'}})});
  await runInDurableObject(stub,async(instance,state)=>{
    const scheduler=new Scheduler(state.storage.sql,state.storage,productionDeps());await scheduler.schedule({id:'three-fair-reminder',kind:'reminder',dueAt:Date.now()-100,occurrenceAt:Date.now()-100,payloadRefs:{reminder_id:'three-fair-reminder'}});
    state.storage.kv.put('telegram_final_outbox_v1',[{id:'three-fair-transport',trace:'three-fair-transport',payload:{chat_id:subject,text:'fixture'},digest:'fixture',ownerSubject:String(subject),doName:route(subject).doName,status:'pending',dueAt:0,createdAt:Date.now(),attempts:0}]);state.storage.kv.put('telegram_final_outbox_due_v1',0);state.storage.kv.put('owner_alarm_last_v1',2);
    await instance.alarm();await instance.alarm();await instance.alarm();
    expect(scheduler.read('three-fair-reminder')).toBeNull();
    const finals=state.storage.kv.get<import('../src/channels/telegram-final-outbox').FinalRecord[]>('telegram_final_outbox_v1')??[];expect(finals.find(r=>r.id==='three-fair-transport')?.status).toBe('delivered');
    const rows=await state.storage.get<import('../src/channels/telegram-owner-inbox').InboxRecord[]>('telegram_owner_inbox_v1');expect(rows?.find(r=>r.updateId===998877)?.state).toBe('awaiting_delivery');
  });
});
it('actual inbox record and alarm transaction rollback leave no admitted update', async()=>{
  const { persistInboxWake }=await import('../src/scheduler/alarm-slot');
  await runInDurableObject(doStub(81102),async(_instance,state)=>{
    const before=await state.storage.get('telegram_owner_inbox_v1');const alarm=await state.storage.getAlarm();
    await expect(state.storage.transaction(async txn=>{await persistInboxWake(txn,[{id:'crash-cut'}],Date.now()+10000);throw new Error('cut before commit');})).rejects.toThrow('cut before commit');
    expect(await state.storage.get('telegram_owner_inbox_v1')).toEqual(before);expect(await state.storage.getAlarm()).toBe(alarm);
  });
});

it('delayed consumed stop cannot stop a replacement run in the real DO', async()=>{
  const { turnControl }=await import('../src/channels/turn-control');const subject=81102;const stub=doStub(subject);
  await runInDurableObject(stub,async(instance,state)=>{
    const internal=instance as unknown as {activeInbox:{runId:string}|null;runtimes:{telegram:{control:ReturnType<typeof turnControl>}};inbox:{transition:(...args:unknown[])=>Promise<boolean>}};
    const control=turnControl();control.bindTarget('old-run');control.begin(true);internal.activeInbox={runId:'old-run'};internal.runtimes.telegram={control};
    const original=internal.inbox.transition.bind(internal.inbox);let entered!:()=>void;const reached=new Promise<void>(r=>entered=r);let release!:()=>void;const gate=new Promise<void>(r=>release=r);
    internal.inbox.transition=async(...args)=>{if(args[2]==='consumed'){entered();await gate;}return original(...args);};
    const request=new Request('https://telegram-owner/enqueue',{method:'POST',headers:{'x-waldo-inbox-secret':'hermetic-test-webhook-secret','x-waldo-telegram-subject':String(subject),'x-waldo-do-name':route(subject).doName},body:JSON.stringify({update_id:991122,message:{message_id:991122,from:{id:subject,is_bot:false},chat:{id:subject,type:'private'},text:'/stop'}})});
    const pending=instance.fetch(request);await reached;control.end();control.bindTarget('new-run');control.begin(true);internal.activeInbox={runId:'new-run'};release();expect((await pending).status).toBe(200);expect(await control.roundAsync()).toBe('');
    internal.inbox.transition=original;internal.activeInbox=null;delete (internal.runtimes as {telegram?:unknown}).telegram;await state.storage.deleteAlarm();
  });
});
it('a recovered consumed control is uncertain, never an answered child',async()=>{
  const { TelegramOwnerInbox }=await import('../src/channels/telegram-owner-inbox');const { persistInboxWake }=await import('../src/scheduler/alarm-slot');
  await runInDurableObject(doStub(81101),async(_instance,state)=>{
    const inbox=new TelegramOwnerInbox(state.storage,persistInboxWake);await inbox.admit({bot:'hermetic-test-bot-token',subject:'81101',doName:route(81101).doName},992233,'steer',{kind:'steer',targetRun:'failed-target'});
    const row=(await inbox.records()).find(r=>r.updateId===992233)!;await inbox.claim(row.id,'crashed','control',Date.now()+180000);await inbox.transition(row.id,'crashed','consumed');await inbox.recover(new Set());expect((await inbox.records()).find(r=>r.id===row.id)?.state).toBe('quarantined');await state.storage.deleteAlarm();
  });
});
it('target execution throw after consumed steer never completes the child',async()=>{
  const { TelegramOwnerInbox }=await import('../src/channels/telegram-owner-inbox');const { persistInboxWake }=await import('../src/scheduler/alarm-slot');const subject=81101;
  await runInDurableObject(doStub(subject),async(instance,state)=>{
    const inbox=new TelegramOwnerInbox(state.storage,persistInboxWake);const binding={bot:'hermetic-test-bot-token',subject:String(subject),doName:route(subject).doName};
    await inbox.admit(binding,993344,JSON.stringify({update_id:993344,message:{from:{id:subject},chat:{id:subject,type:'private'},text:'target'}}));
    const internal=instance as unknown as {activeInbox:import('../src/channels/telegram-owner-inbox').InboxRecord|null;turn:()=>Promise<void>;drainInbox:()=>Promise<void>};const original=internal.turn.bind(internal);let childId='';
    internal.turn=async()=>{const target=internal.activeInbox!;await inbox.admit(binding,993345,'steer',{kind:'steer',targetRun:target.runId!});const child=(await inbox.records()).find(r=>r.updateId===993345)!;childId=child.id;await inbox.claim(child.id,'consumed-child','control',Date.now()+180000);await inbox.transition(child.id,'consumed-child','consumed');throw new Error('target execution failed');};
    await internal.drainInbox();expect((await inbox.records()).find(r=>r.id===childId)?.state).toBe('quarantined');expect((await inbox.records()).find(r=>r.id===childId)?.reason).toBe('consumed_target_outcome_uncertain');internal.turn=original;await state.storage.deleteAlarm();
  });
});
