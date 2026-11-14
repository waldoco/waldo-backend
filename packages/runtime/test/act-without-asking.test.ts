// "Just do it" (act_without_asking): the owner's choice to let Waldo act on what they ask without an approval card. Live only
// where AUTONOMOUS_BY_DEFAULT is 1, on unless the owner turns it off, and off means every consequential effect is a card. With
// AUTONOMY_OWNER_TURNS the line is the turn's provenance: a turn the owner started may act after it read outside text, behind
// the recipient guard; a turn outside content started keeps its cards. Payments, passwords, permanent deletion and lasting
// access keep theirs either way.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { approvalDesk, askedBy, ownerStartedTurn, type AskedOptions, type McpReach } from '../src/channels/approvals';
import { ACT_WITHOUT_ASKING_KEY, actWithoutAsking, actsWithoutAsking, setActWithoutAsking } from '../src/channels/act-without-asking';
import { APP_ACT_WITHOUT_ASKING_RECEIPTS_V1 } from '../../contracts/src/app/controls';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appApprovalLink } from '../src/channels/surfaces/app';
import type { GoogleClient } from '../src/connectors/google';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';
import { callMcpToolHandler, type McpOwnerServers } from '../src/tools/live/mcp';
import { emailProposal } from './fixtures/email-send';
import { ownerTyped } from './helpers/owner-typed';
import { sendMessageHandler } from '../src/tools/live/messaging';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { readThreadArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type ToolName } from '@waldo/contracts';

const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);
const OWNER = 447700900123;
type Surface = 'whatsapp' | 'imessage' | 'telegram' | 'app';
type Options = Readonly<{ master?: boolean; ownerTurns?: boolean; choice?: 'on' | 'off'; undoCancels?: boolean; guests?: number; idPrefix?: string }>;

const harness = (state: DurableObjectState, surface: Surface, options: Options = {}) => {
  const { sql, kv } = state.storage;
  const master = options.master !== false;
  if (options.choice) setActWithoutAsking(kv, options.choice, master);
  const messages: string[] = [], sent: string[] = [], created: unknown[] = [], cancelled: string[] = [], emails: string[] = [], submitted: string[] = [], mcp: string[] = [];
  let n = 0, ref = 0;
  const client = {
    account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
    createEvent: async (input: unknown) => { created.push(input); return { id: `ev${created.length}`, title: 'Lunch', start: '', end: '', all_day: false, etag: 'v2' }; },
    cancelEvent: async (id: string) => { cancelled.push(id); return { id, status: 'cancelled', etag: 'v3' }; },
    event: async (id: string) => ({ id, title: 'Sync', start: '2026-11-16T15:00:00Z', end: '2026-11-16T16:00:00Z', all_day: false, etag: 'v2', status: 'confirmed', ...(options.guests ? { attendees: options.guests } : {}) }),
    sendRaw: async (raw: string) => { emails.push(raw); return { message_id: `g${emails.length}` }; },
    findSentByMessageId: async (messageId: string) => ({ message_id: `g${emails.length}`, thread_id: 't', rfc822_message_id: messageId, label_ids: ['SENT'] }),
  } as unknown as GoogleClient;
  const desk = approvalDesk(sql, {
    owner: OWNER, surface, appIdentity: () => true, appLink: appApprovalLink,
    // As the owner object wires it: the deploy's master switch and the owner's stored choice, read at each decision.
    autonomous: () => actsWithoutAsking(kv, master), ownerTurns: () => options.ownerTurns !== false,
    ownerMessageAt: () => NOW + 30_000, ...(options.undoCancels ? { undoCancels: true } : {}),
    call: async (method: string, body: object) => {
      if (method !== 'sendMessage') return true;
      messages.push((body as { text: string }).text);
      ref += 1;
      return surface === 'telegram' ? { message_id: ref, chat: { id: OWNER } } : { messages: [{ id: `${surface}.card-${ref}` }] };
    },
    google: async () => client, newId: () => `${options.idPrefix ?? ''}${++n}`, now: () => NOW, timezone: 'UTC', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => NOW),
    sendMessage: async proposal => { sent.push(proposal.content); return { provider_id: `sent-${sent.length}` }; },
    canSendMessage: () => true, retire: async () => undefined,
    browserSubmit: async p => { submitted.push(p.action.description); return { status: 'verified_with_receipt', message: 'Done.', receipt: {} } as never; },
    mcpCall: async p => { mcp.push(p.tool); return { provider_id: `mcp-${mcp.length}`, result: 'created' }; },
  });
  const status = (id: string) => sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  return { desk, messages, sent, created, cancelled, emails, submitted, mcp, status, kv };
};
const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => work(state));

const message = () => ({ channel: 'whatsapp', content: 'Running 10 minutes late', idempotency_key: `key-${crypto.randomUUID()}` });
const email = (to: readonly string[], body = 'Thursday works for me.') => emailProposal({ to: [...to], subject: 'Re: Thursday', body, message_id: `<${crypto.randomUUID()}@waldo-send>` });
// A turn the owner started and that has read outside text since (an email): the 2078 rule (asked) no longer holds.
const read = (words: string): AskedOptions => ({ asked: false, ownerTurn: { words } });
// A turn outside content started (inbound mail, a forward, a Brief, a proactive run): the host sets no owner message.
const outsideStarted: AskedOptions = { asked: false };
const clean = (words: string): AskedOptions => ({ asked: true, ownerTurn: { words } });
const CATALOGUE: McpReach = { catalogue: true, destructive: false, sendsAsOwner: false };
const mcpCall = (tool = 'create_page') => ({ server: 'notion', tool, args: { title: 'Plan' }, connection: 'c1', tool_digest: 'd1', operation_ref: `op-${crypto.randomUUID()}` });
const PAYMENT = { url: 'https://shop.example/checkout', action: { selector: '#pay', description: 'Pay £12.00' }, binding: { total: '12.00', cc_number: '4111111111111111' }, steps: ['Filled the card form'], secretKeys: ['cc_number'] };
const SIGN_IN = { url: 'https://portal.example/login', action: { selector: '#go', description: 'Sign in' }, binding: { user: 'owner', password: 'hunter2' }, steps: ['Filled the sign-in form'], secretKeys: ['password'] };
const GRANT = { scope: { class: 'calendar.move_own_block' as const, account: 'owner@example.test', window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30 },
  limits: { max_per_day: 3, timezone: 'UTC' }, valid_from: Date.UTC(2026, 10, 15), expires_at: Date.UTC(2026, 10, 30) };

describe('the owner\'s choice', () => {
  it('reads on for an owner who never chose, and acts only where the master switch is on', async () => {
    await owner('choice-default', async state => {
      expect(state.storage.kv.get(ACT_WITHOUT_ASKING_KEY)).toBeUndefined();
      expect(actWithoutAsking(state.storage.kv, true)).toEqual({ on: true, available: true });
      expect(actWithoutAsking(state.storage.kv, false)).toEqual({ on: true, available: false });
      expect([actsWithoutAsking(state.storage.kv, true), actsWithoutAsking(state.storage.kv, false)]).toEqual([true, false]);
    });
  });

  it('saves on and off with the contract\'s receipts, and says so honestly where it is not active', async () => {
    await owner('choice-set', async state => {
      const { kv } = state.storage;
      expect(setActWithoutAsking(kv, 'on', true)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.already_on);
      expect(setActWithoutAsking(kv, 'off', true)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.off);
      expect(setActWithoutAsking(kv, 'off', true)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.already_off);
      expect(actsWithoutAsking(kv, true)).toBe(false);
      expect(setActWithoutAsking(kv, 'on', false)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.inactive_on);
      expect(actWithoutAsking(kv, false)).toEqual({ on: true, available: false });
      expect(setActWithoutAsking(kv, 'off', false)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.inactive_off);
      expect(setActWithoutAsking(kv, 'yes', true)).toBe(false);
      expect(actWithoutAsking(kv, true).on).toBe(false);
    });
  });
});

describe('on, off and the master switch', () => {
  it('on by default: what the owner asked for runs with no card', async () => {
    await owner('default-on', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeSendMessage(message(), clean('tell them I am running 10 minutes late'));
      expect(f.messages).toEqual([]);
      expect(f.sent).toEqual(['Running 10 minutes late']);
      expect(f.status(id)).toBe('done');
    });
  });

  it('off: every consequential effect is a card, the owner\'s own clean request included, as before autonomy by default', async () => {
    await owner('choice-off', async state => {
      const f = harness(state, 'whatsapp', { choice: 'off', undoCancels: true });
      const ids = [
        await f.desk.proposeSendMessage(message(), clean('tell them I am late')),
        await f.desk.proposeSendEmail(await email(['sam@example.test']), clean('email sam@example.test that Thursday works')),
        await f.desk.propose({ action: 'create', title: 'Lunch', start: '2026-11-16T12:00:00Z' as never, end: '2026-11-16T13:00:00Z' as never, reason: 'lunch' }, 'turn-1', 'op-1', clean('book lunch')),
        await f.desk.proposeMcpCall(mcpCall(), { ...clean('make a page'), reach: CATALOGUE }),
      ];
      expect(f.sent).toEqual([]);
      expect(f.emails).toEqual([]);
      expect(f.created).toEqual([]);
      expect(f.mcp).toEqual([]);
      expect(ids.map(f.status)).toEqual(['open', 'open', 'open', 'open']);
      expect(ids.map(id => f.desk.askedOutcome(id))).toEqual([null, null, null, null]);
      // Undo in the owner's words follows the choice too.
      expect(f.desk.autonomous()).toBe(false);
    });
  });

  it('master switch 0: the choice stays on and changes nothing, so everything cards as before', async () => {
    await owner('master-off', async state => {
      const f = harness(state, 'whatsapp', { master: false, choice: 'on' });
      const ids = [await f.desk.proposeSendMessage(message(), clean('tell them I am late')),
        await f.desk.proposeSendEmail(await email(['sam@example.test']), read('reply to sam@example.test'))];
      expect(f.sent).toEqual([]);
      expect(f.emails).toEqual([]);
      expect(ids.map(f.status)).toEqual(['open', 'open']);
      expect(f.desk.autonomous()).toBe(false);
    });
  });
});

describe('provenance: who started the turn', () => {
  it('a turn the owner started that read email acts with no card', async () => {
    await owner('owner-read-mail', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeSendEmail(await email(['sam@example.test']), read('Read Sam\'s email and tell sam@example.test Thursday works'));
      expect(f.messages).toEqual([]);
      expect(f.emails).toHaveLength(1);
      expect(f.desk.askedOutcome(id)).toMatchObject({ state: 'done', undo: false });
      const task = await f.desk.proposeSendMessage(message(), read('let them know I am late after you check my inbox'));
      expect(f.status(task)).toBe('done');
    });
  });

  it('without AUTONOMY_OWNER_TURNS the same turn cards, exactly as autonomy by default rules it', async () => {
    await owner('owner-read-mail-narrow', async state => {
      const f = harness(state, 'whatsapp', { ownerTurns: false });
      const id = await f.desk.proposeSendEmail(await email(['sam@example.test']), read('tell sam@example.test Thursday works'));
      expect(f.emails).toEqual([]);
      expect(f.status(id)).toBe('open');
      // The clean case still runs: the narrow rule is unchanged.
      const clean2 = await f.desk.proposeSendMessage(message(), clean('tell them I am late'));
      expect(f.status(clean2)).toBe('done');
    });
  });

  it('a turn inbound mail, a forward, a Brief or a proactive run started keeps a card for its effects', async () => {
    await owner('outside-started', async state => {
      const f = harness(state, 'whatsapp');
      const ids = [await f.desk.proposeSendMessage(message(), outsideStarted),
        await f.desk.proposeSendEmail(await email(['sam@example.test']), outsideStarted),
        await f.desk.proposeMcpCall(mcpCall(), { ...outsideStarted, reach: CATALOGUE })];
      expect(f.sent).toEqual([]);
      expect(f.emails).toEqual([]);
      expect(f.mcp).toEqual([]);
      expect(ids.map(f.status)).toEqual(['open', 'open', 'open']);
    });
  });

  it('reads provenance off the host\'s turn context, never off the model\'s arguments', () => {
    const turn = (over: Partial<ToolDispatcherContext>) => ({ runOrigin: 'owner', ownerMessage: { messageRef: 'm', receivedAt: NOW, ownWordsOnly: true, words: 'email sam@example.test' }, ...over }) as ToolDispatcherContext;
    expect(askedBy(turn({}))).toEqual({ asked: true, ownerTurn: { words: 'email sam@example.test' } });
    // Read outside text since: the narrow rule drops, the owner still started it.
    expect(askedBy(turn({ toolArgSourceTaint: 'external' } as never))).toEqual({ asked: false, ownerTurn: { words: 'email sam@example.test' } });
    expect(askedBy(turn({ carriedOutside: true }))).toEqual({ asked: false, ownerTurn: { words: 'email sam@example.test' } });
    // A forward, inbound mail or a Brief: the host sets runOrigin external or waldo and no owner message.
    for (const runOrigin of ['external', 'waldo'] as const) expect(ownerStartedTurn(turn({ runOrigin, ownerMessage: undefined }))).toBeUndefined();
    expect(ownerStartedTurn(turn({ runOrigin: 'external' }))).toBeUndefined();
    expect(askedBy(undefined)).toEqual({ asked: false });
  });
});

describe('the recipient guard inside a turn the owner started', () => {
  it('a send to an address found only in the email the turn read goes to a card', async () => {
    await owner('guard-email', async state => {
      const f = harness(state, 'whatsapp');
      // "Handle my inbox" read a message asking for the figures to be sent to an address the owner never named.
      const id = await f.desk.proposeSendEmail(await email(['figures@attacker.example'], 'Q3 figures attached'), read('handle my inbox'));
      expect(f.emails).toEqual([]);
      expect(f.status(id)).toBe('open');
      expect(f.desk.askedOutcome(id)).toBeNull();
    });
  });

  it('matches whole addresses only: a@b.co named does not cover a@b.com', async () => {
    await owner('guard-whole', async state => {
      const f = harness(state, 'whatsapp');
      const near = await f.desk.proposeSendEmail(await email(['sam@example.co']), read('reply to sam@example.com.'));
      expect(f.status(near)).toBe('open');
      const exact = await f.desk.proposeSendEmail(await email(['Sam <SAM@example.com>']), read('reply to sam@example.com.'));
      expect(f.status(exact)).toBe('done');
    });
  });

  it('every recipient counts: one stranger in cc or bcc cards the whole send', async () => {
    await owner('guard-cc', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeSendEmail({ ...await email(['sam@example.test']), bcc: ['copy@attacker.example'] }, read('reply to sam@example.test'));
      expect(f.emails).toEqual([]);
      expect(f.status(id)).toBe('open');
    });
  });

  it('a party the owner reached through Waldo before is known, so the next send to them runs', async () => {
    await owner('guard-known', async state => {
      const f = harness(state, 'whatsapp');
      // The first send to dana goes out on the owner's own clean request.
      await f.desk.proposeSendEmail(await email(['Dana Lee <dana@example.test>']), clean('email dana@example.test'));
      expect(f.emails).toHaveLength(1);
      const id = await f.desk.proposeSendEmail(await email(['dana@example.test'], 'Following up.'), read('follow up with Dana on that thread'));
      expect(f.emails).toHaveLength(2);
      expect(f.status(id)).toBe('done');
    });
  });

  it('a card the owner never approved does not make its recipient known', async () => {
    await owner('guard-carded', async state => {
      const f = harness(state, 'whatsapp');
      const first = await f.desk.proposeSendEmail(await email(['figures@attacker.example']), read('handle my inbox'));
      expect(f.status(first)).toBe('open');
      const second = await f.desk.proposeSendEmail(await email(['figures@attacker.example'], 'Again'), read('handle my inbox'));
      expect(f.status(second)).toBe('open');
      expect(f.emails).toEqual([]);
    });
  });

  it('a new event\'s guest named only in outside text cards; one the owner named runs', async () => {
    await owner('guard-guests', async state => {
      const f = harness(state, 'whatsapp');
      const event = (attendees: string[]) => ({ action: 'create' as const, title: 'Sync', start: '2026-11-16T12:00:00Z' as never, end: '2026-11-16T13:00:00Z' as never, reason: 'sync', attendees });
      const stranger = await f.desk.propose(event(['ceo@attacker.example']), 'turn-1', 'op-1', read('set up what that email asks'));
      expect(f.created).toEqual([]);
      expect(f.status(stranger)).toBe('open');
      const named = await f.desk.propose(event(['sam@example.test']), 'turn-2', 'op-2', read('invite sam@example.test to a sync at noon Monday'));
      expect(f.created).toHaveLength(1);
      expect(f.status(named)).toBe('done');
    });
  });

  it('a write that speaks as the owner on a connected app cards once the turn read outside text: code cannot list who it reaches', async () => {
    await owner('guard-mcp-send', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeMcpCall({ ...mcpCall('slack_send_message'), server: 'slack' }, { ...read('post the update in #team'), reach: { catalogue: true, destructive: false, sendsAsOwner: true } });
      expect(f.mcp).toEqual([]);
      expect(f.status(id)).toBe('open');
    });
  });
});

describe('what runs with the choice on', () => {
  it('a connected app\'s tool call runs and is reported', async () => {
    await owner('mcp-runs', async state => {
      const f = harness(state, 'app');
      const id = await f.desk.proposeMcpCall(mcpCall(), { ...read('make a Notion page with the plan from that email'), reach: CATALOGUE });
      expect(f.mcp).toEqual(['create_page']);
      expect(f.status(id)).toBe('done');
      expect(f.desk.askedOutcome(id)).toMatchObject({ state: 'done', undo: false });
    });
  });

  it('a calendar cancel Waldo can put back runs, guests included, and offers its undo', async () => {
    await owner('cancel-runs', async state => {
      const f = harness(state, 'whatsapp', { undoCancels: true, guests: 3 });
      const id = await f.desk.propose({ action: 'cancel', event_id: 'ev9', reason: 'not needed' } as never, 'turn-1', 'op-1', read('cancel my 3pm sync'));
      expect(f.cancelled).toEqual(['ev9']);
      expect(f.desk.askedOutcome(id)).toMatchObject({ state: 'done', undo: true });
    });
  });
});

describe('what still cards with the choice on', () => {
  it('a payment, a purchase or entered credentials: a browser submit is always a card', async () => {
    await owner('still-browser', async state => {
      const f = harness(state, 'whatsapp');
      const ids = [await f.desk.proposeBrowserSubmit(PAYMENT), await f.desk.proposeBrowserSubmit(SIGN_IN)];
      expect(f.submitted).toEqual([]);
      expect(ids.map(f.status)).toEqual(['open', 'open']);
    });
  });

  it('a permanent deletion: a cancel Waldo cannot put back, and a tool its server marks destructive', async () => {
    await owner('still-deletion', async state => {
      const f = harness(state, 'whatsapp');
      const cancel = await f.desk.propose({ action: 'cancel', event_id: 'ev9', reason: 'gone' } as never, 'turn-1', 'op-1', clean('delete my 3pm'));
      expect(f.cancelled).toEqual([]);
      expect(f.status(cancel)).toBe('open');
      const destroy = await f.desk.proposeMcpCall(mcpCall('delete_page'), { ...clean('delete that page'), reach: { ...CATALOGUE, destructive: true } });
      expect(f.mcp).toEqual([]);
      expect(f.status(destroy)).toBe('open');
    });
  });

  it('a tool on a server the owner added by address: code cannot tell a purchase there', async () => {
    await owner('still-unlisted', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeMcpCall({ ...mcpCall('place_order'), server: 'shop' }, { ...clean('order my usual'), reach: { ...CATALOGUE, catalogue: false } });
      expect(f.mcp).toEqual([]);
      expect(f.status(id)).toBe('open');
    });
  });

  it('lasting access: a standing grant is a card, and only a tap approves it', async () => {
    await owner('still-grant', async state => {
      const f = harness(state, 'whatsapp');
      const id = await f.desk.proposeStandingGrant(GRANT);
      expect(f.status(id)).toBe('open');
      expect(f.desk.askedOutcome(id)).toBeNull();
    });
  });
});

describe('every surface decides the same way', () => {
  for (const surface of ['whatsapp', 'imessage', 'telegram', 'app'] as const) {
    it(`${surface}: an owner-started turn runs, a stranger recipient and an outside-started turn card`, async () => {
      await owner(`surface-${surface}`, async state => {
        const f = harness(state, surface);
        const ran = await f.desk.proposeSendEmail(await email(['sam@example.test']), read('reply to sam@example.test'));
        const guarded = await f.desk.proposeSendEmail(await email(['x@attacker.example']), read('handle my inbox'));
        const started = await f.desk.proposeSendMessage(message(), outsideStarted);
        expect([f.status(ran), f.status(guarded), f.status(started)]).toEqual(['done', 'open', 'open']);
      });
    });
  }
});

describe('call_mcp_tool hands the desk what the connection knows', () => {
  const servers = (catalogue: boolean, destructive: boolean): McpOwnerServers => ({
    list: () => [{ name: 'notion' }] as never, search: async () => ({}) as never, checkAnswers: async () => [] as never, sendsNow: () => false, invoke: async () => ({}) as never,
    describe: async () => ({ connection: 'c1', def: { name: 'create_page', inputSchema: { type: 'object' }, ...(destructive ? { annotations: { destructiveHint: true } } : {}) }, digest: 'd1', runs: 'asks_first', catalogue, sends_as_owner: false }) as never,
  });
  const ctx = { authenticatedUserId: 'owner', trigger: 'user_message', turnId: 't1', toolCallId: 'c1', runOrigin: 'owner', toolArgSourceTaint: 'external',
    ownerMessage: { messageRef: 'm', receivedAt: NOW, ownWordsOnly: true, words: 'make a page from that email' } } as unknown as ToolDispatcherContext;
  for (const [catalogue, destructive, runs] of [[true, false, true], [true, true, false], [false, false, false]] as const) {
    it(`catalogue ${catalogue}, destructive ${destructive}: ${runs ? 'runs' : 'cards'}`, async () => {
      await owner(`mcp-handler-${catalogue}-${destructive}`, async state => {
        const f = harness(state, 'whatsapp');
        const handler = callMcpToolHandler(undefined, f.desk, undefined, servers(catalogue, destructive));
        const result = await handler.handle({ server: 'notion', tool: 'create_page', args: { title: 'Plan' } } as never, ctx) as { ok: true; data: { applied: boolean } };
        expect(result.data.applied).toBe(runs);
        expect(f.mcp).toEqual(runs ? ['create_page'] : []);
      });
    });
  }
});

// Through the real owner turn: the model's calls are scripted; the host's context, the send tool and the desk are real.
describe('the real owner turn carries the provenance the desk decides on', () => {
  const allowed = (name: ToolName) => triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes(name));
  const timer = async <T,>(_hop: string, work: () => Promise<T>) => work();
  const turnHarness = (state: DurableObjectState, options: Options = {}) => {
    const f = harness(state, 'whatsapp', options);
    const calls: { name: string; arguments: string }[] = [], seen: AskedOptions[] = [];
    const gateway: LLMGatewayAdapter = { async complete(request) {
      const reply = (text: string, call?: { name: string; arguments: string }) => ({ ok: true as const, data: { model: request.request.model, text, ...(call ? { tool_calls: [{ call_id: `c${calls.length}`, ...call }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
      if (request.request.response_format) return reply('{}');
      const next = calls.shift();
      return next ? reply('', next) : reply('Done.');
    } };
    const mail = { name: 'read_thread' as const, description: 'Read a mail thread.', schema: readThreadArgsSchema, trigger_allowlist: allowed('read_thread'),
      handle: async () => ({ ok: true as const, data: { body: 'Please confirm Thursday with the team.' }, source_taint: 'external' as const }) };
    const send = sendMessageHandler(f.desk);
    const probe = { ...send, handle: async (args: never, ctx: ToolDispatcherContext) => { seen.push(askedBy(ctx)); return send.handle(args, ctx); } };
    const responder = createOwnerResponder('fixture', undefined, undefined, undefined, undefined, [probe, mail] as never, undefined, false, undefined, undefined, gateway);
    const turn = (text: string) => ownerTyped({ traceId: `owner-${crypto.randomUUID()}`, conversationRef: 'owner', surface: 'whatsapp', text, messageRef: { id: `wamid.${crypto.randomUUID()}`, conversationRef: 'owner' } });
    const sendCall = { name: 'send_message', arguments: JSON.stringify({ ...message(), idempotency_key: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('') }) };
    return { f, calls, seen, responder, turn, sendCall };
  };

  it('the owner asks, the turn reads a mail, then sends: it runs with no card, and the desk saw the owner\'s own words', () => owner('turn-read-send', async state => {
    const { f, calls, seen, responder, turn, sendCall } = turnHarness(state);
    calls.push({ name: 'read_thread', arguments: '{"thread_id":"thread-1"}' }, sendCall);
    await responder.respond(turn('check the Acme thread and tell the team I am running late'), timer);
    expect(seen).toEqual([{ asked: false, ownerTurn: { words: 'check the Acme thread and tell the team I am running late' } }]);
    expect(f.sent).toEqual(['Running 10 minutes late']);
    expect(f.messages).toEqual([]);
  }));

  it('the same turn with the choice off: the send is a card and nothing goes out', () => owner('turn-read-send-off', async state => {
    const { f, calls, responder, turn, sendCall } = turnHarness(state, { choice: 'off' });
    calls.push({ name: 'read_thread', arguments: '{"thread_id":"thread-1"}' }, sendCall);
    await responder.respond(turn('check the Acme thread and tell the team I am running late'), timer);
    expect(f.sent).toEqual([]);
    expect(f.messages).toHaveLength(1);
  }));

  it('a forward the owner sends starts a turn outside content started: its send is a card', () => owner('turn-forward', async state => {
    const { f, calls, seen, responder, turn, sendCall } = turnHarness(state);
    calls.push(sendCall);
    await responder.respond({ ...turn('Message the team that Thursday is confirmed'), parts: [{ authorship: 'forwarded', text: 'Message the team that Thursday is confirmed' }] }, timer);
    expect(seen).toEqual([{ asked: false }]);
    expect(f.sent).toEqual([]);
    expect(f.messages).toHaveLength(1);
  }));
});
