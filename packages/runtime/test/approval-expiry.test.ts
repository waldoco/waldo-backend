import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appApprovalV1Schema } from '../../contracts/src/app/approvals';
import { appApprovalParts, approvalDesk, PROPOSAL_TTL_MS } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appCaller } from '../src/channels/surfaces/app';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';

const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);
const HOUR = 60 * 60_000;
const at = (ms: number) => new Date(ms).toISOString() as never;

const deskIn = (state: DurableObjectState, client: Partial<GoogleClient> = {}, google: () => Promise<GoogleClient> = async () => client as GoogleClient) => {
  let now = NOW, n = 0;
  const logs: object[] = [];
  const desk = approvalDesk(state.storage.sql, { owner: 7_000_000_000_001, surface: 'app', call: appCaller(), newId: () => `exp${++n}`, now: () => now,
    timezone: 'UTC', log: entry => logs.push(entry), google, currentRunRef: () => 'run-exp', effects: ownerEffectLedger(state.storage, () => now) });
  const statusOf = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  return { desk, statusOf, logs, clock: { set: (ms: number) => { now = ms; }, get: () => now } };
};
const walk = (start: number, title = 'Walk') => ({ action: 'create' as const, title, start: at(start), end: at(start + 30 * 60_000), reason: 'a free slot' });

describe('approval expiry', () => {
  it('closes a request at its expiry on every reader, and offers no decision after it', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-expiry-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const { desk, statusOf, logs, clock } = deskIn(state);
      const first = await desk.propose(walk(NOW + HOUR));
      const second = await desk.propose(walk(NOW + 2 * HOUR, 'Swim'));
      const message = await desk.proposeSendMessage({ channel: 'whatsapp', content: 'Running late.', idempotency_key: 'e'.repeat(64) });

      clock.set(NOW + HOUR - 1);
      expect(desk.ledger([])).toMatch(/- Add "Walk".*\(waiting on you\)/);
      expect((await desk.approvals(clock.get(), { id: first }))[0]).toMatchObject({ state: 'open', actions: ['approve', 'edit', 'skip'] });

      // Exactly at expires_at the request is closed, and the ledger read alone records it.
      clock.set(NOW + HOUR);
      const ledger = desk.ledger([]);
      expect(ledger).not.toMatch(/Walk.*waiting on you/);
      expect(ledger).toMatch(/- expired: Add "Walk"/);
      expect(statusOf(first)).toBe('expired');
      expect(logs).toEqual([{ trace: 'approvals', hop: 'approvals_sweep', ms: 0, ok: true, code: 'approvals_expired', detail: '1' }]);

      clock.set(NOW + 2 * HOUR);
      expect(desk.pending(clock.get()).map(item => item.id)).toEqual([message]);
      expect(statusOf(second)).toBe('expired');

      clock.set(NOW + PROPOSAL_TTL_MS);
      expect(await desk.approvals(clock.get(), { state: 'open' })).toEqual([]);
      expect(statusOf(message)).toBe('expired');
      const expired = await desk.approvals(clock.get(), { state: 'expired' });
      expect(expired.map(item => item.approval_id).sort()).toEqual([first, second, message].sort());
      for (const item of expired) {
        expect(item).toMatchObject({ state: 'expired', actions: [] });
        expect(appApprovalV1Schema.safeParse(item).success).toBe(true);
      }
      expect((await desk.approvals(clock.get())).every(item => item.state === 'expired')).toBe(true);
      expect(appApprovalParts(state.storage.sql)('run-exp').live).toEqual([]);
    });
  });

  it('answers any decision on an expired request with its expiry and records nothing new', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-expiry-decide-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const { desk, statusOf, clock } = deskIn(state);
      const skipped = await desk.proposeSendMessage({ channel: 'whatsapp', content: 'Running late.', idempotency_key: 'a'.repeat(64) });
      const approved = await desk.proposeSendMessage({ channel: 'whatsapp', content: 'On my way.', idempotency_key: 'b'.repeat(64) });
      clock.set(NOW + PROPOSAL_TTL_MS);
      for (const [id, action] of [[skipped, 's'], [approved, 'a'], [approved, 'e'], [skipped, 's']] as const) {
        const out = await desk.decide(id, action, 'test');
        expect(out.toast).toBe('This proposal expired');
        expect(out.message).toContain('nothing happened');
        expect(statusOf(id)).toBe('expired');
      }
    });
  });

  it('also closes a request the owner asked to change, or whose card was never confirmed', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-expiry-other-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const { desk, statusOf, clock } = deskIn(state);
      const edited = await desk.proposeSendMessage({ channel: 'whatsapp', content: 'Running late.', idempotency_key: 'c'.repeat(64) });
      expect((await desk.decide(edited, 'e', 'test')).toast).toBe('Tell me what to change');
      expect(statusOf(edited)).toBe('changing');
      let n = 0;
      const unconfirmedDesk = approvalDesk(state.storage.sql, { owner: 42, call: async () => { throw new Error('send failed'); }, newId: () => `unc${++n}`, now: () => clock.get(),
        timezone: 'UTC', log: () => {}, google: async () => null });
      await unconfirmedDesk.proposeSendMessage({ channel: 'whatsapp', content: 'Hello.', idempotency_key: 'd'.repeat(64) }).catch(() => undefined);
      const unconfirmed = state.storage.sql.exec<{ id: string }>("SELECT id FROM ledger WHERE status = 'card_unconfirmed'").one().id;

      clock.set(NOW + PROPOSAL_TTL_MS);
      expect(await desk.approvals(clock.get(), { id: edited })).toMatchObject([{ state: 'expired', actions: [] }]);
      expect(await desk.approvals(clock.get(), { id: unconfirmed })).toMatchObject([{ state: 'expired', actions: [] }]);
      expect(desk.ledger([])).toContain('- nothing waiting on you');
    });
  });

  const gated = () => {
    let release!: () => void, entered!: () => void;
    const open = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    return { release, reached, pass: async () => { entered(); await open; } };
  };
  const calendarClient = (created: string[], dispatch = gated()) => ({
    createEvent: async ({ id }: { id?: string }) => { await dispatch.pass(); created.push(id ?? ''); return { id: id ?? 'ev1', etag: 'e1' }; },
    event: async (id: string) => ({ id, title: 'Walk', start: at(NOW + HOUR), end: at(NOW + HOUR + 30 * 60_000), all_day: false, etag: 'e1', status: 'confirmed' }),
  }) as unknown as GoogleClient;

  it('never closes a request whose approved change is already in flight', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-expiry-inflight-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const created: string[] = [], dispatch = gated();
      const { desk, statusOf, clock } = deskIn(state, calendarClient(created, dispatch));
      const id = await desk.propose(walk(NOW + HOUR));
      clock.set(NOW + HOUR - 60_000);
      const approving = desk.decide(id, 'a', 'test');
      await dispatch.reached;
      clock.set(NOW + HOUR + 1);
      expect(desk.ledger([])).not.toContain('- expired:');
      expect((await desk.approvals(clock.get(), { id }))[0]?.state).not.toBe('expired');
      expect(statusOf(id)).toBe('open');
      dispatch.release();
      expect((await approving).toast).toBe('Done');
      expect(created).toHaveLength(1);
      expect(statusOf(id)).toBe('done');
    });
  });

  it('reconciles, after expiry, an approval whose change Google already applied, and never writes it twice', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-expiry-recorded-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const events = new Map<string, Record<string, unknown>>(), writes: string[] = [], reads: string[] = [];
      const client = {
        createEvent: async ({ id, title, start, end, operationMarker }: { id: string; title: string; start: string; end: string; operationMarker: string }) => {
          writes.push(id); events.set(id, { id, title, start, end, all_day: false, etag: 'e1', status: 'confirmed', operation_marker: operationMarker }); return { id, etag: 'e1' };
        },
        event: async (id: string) => { reads.push(id); const event = events.get(id); if (!event) throw new Error('not found'); return event; },
      } as unknown as GoogleClient;
      const { desk, statusOf, clock } = deskIn(state, client);
      const proposal = walk(NOW + HOUR);
      const id = await desk.propose(proposal);
      const payload = JSON.parse(state.storage.sql.exec<{ payload_json: string }>('SELECT payload_json FROM ledger WHERE id = ?', id).one().payload_json);
      // Before a restart, the approval's change reached Google but its result was never recorded: the journal holds
      // an attempting effect (the ledger's own key) and the request is still open.
      const operation = `approval:${id}:apply`, marker = await sha256Hex(operation);
      const reserved = ownerEffectLedger(state.storage, () => NOW).reserve({ operationId: operation, owner_ref: '7000000000001', tool: 'calendar_change', payload });
      state.storage.kv.put(`owner:effect:${operation}`, { ...reserved, state: 'attempting' });
      await client.createEvent({ id: marker, title: proposal.title, start: proposal.start, end: proposal.end, operationMarker: marker });

      clock.set(NOW + HOUR + 1);
      expect(desk.ledger([])).not.toContain('- expired:');
      expect((await desk.decide(id, 'a', 'test')).toast).toBe('Done');
      expect(writes).toEqual([marker]);
      expect(reads).toEqual([marker]);
      expect(statusOf(id)).toBe('done');
    });
  });

  it('applies nothing when a read closes the request before its change starts', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`approval-expiry-race-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const created: string[] = [], fetching = gated();
      const client = calendarClient(created);
      let fetches = 0;
      // The proposal's own client fetch passes; the approval's waits.
      const { desk, statusOf, clock } = deskIn(state, client, async () => { if (++fetches > 1) await fetching.pass(); return client; });
      const id = await desk.propose(walk(NOW + HOUR));
      clock.set(NOW + HOUR - 60_000);
      const approving = desk.decide(id, 'a', 'test');
      await fetching.reached;
      clock.set(NOW + HOUR + 1);
      expect(desk.ledger([])).toMatch(/- expired: Add "Walk"/);
      fetching.release();
      expect((await approving).toast).toBe('This proposal expired');
      expect(created).toEqual([]);
      expect(statusOf(id)).toBe('expired');
    });
  });
});
