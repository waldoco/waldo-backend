import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnerProactivity, type OwnerProactivityAccount } from '../src/channels/owner-proactivity';
import { setProactivityArgsSchema } from '@waldo/contracts';
import { loopBook, loopHandlers } from '../src/channels/loops';
import { responsibilityBook } from '../src/channels/responsibilities';
import { updateBook } from '../src/channels/update-cards';
import { createProactivityBook } from '../src/proactivity/book';
import type { GoogleClient, ThreadMessage } from '../src/connectors/google';
import { parseDiscoveryCandidates } from '../src/proactivity/discovery';

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
const at = Date.parse('2026-10-10T10:00:00Z');
const accountRow = (id = 'personal', features = { mail: true }): OwnerProactivityAccount => ({ id, email: `${id}@example.test`, revision: 'grant-1', connected: true, available: true, features });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('expected one row'); return rows[0]; } };
  } } as unknown as SqlStorage;
  let depth = 0;
  const transaction = <T>(work: () => T): T => {
    const name = `nested_${depth++}`; db.exec(`SAVEPOINT ${name}`);
    try { const result = work(); db.exec(`RELEASE ${name}`); depth--; return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); depth--; throw error; }
  };
  let now = at, sequence = 0, ownerCurrent = true, audience = 'owner:app';
  let rows: readonly OwnerProactivityAccount[] = [accountRow()];
  const clock = { now: () => now, newId: () => `fixture-${++sequence}` };
  const book = createProactivityBook(sql, { ...clock, transaction, ownerKey: 'owner-a' });
  const loops = loopBook(sql, clock), responsibilities = responsibilityBook(sql, clock), updates = updateBook(sql, transaction);
  const messages: Record<string, readonly ThreadMessage[]> = {
    form: [{ id: 'form-original', from: 'school@example.test', subject: 'Winter form', at: new Date(at - 6 * 86400_000).toISOString(), body: 'The winter form is due November 2. Please return the completed form.' }],
    rize: [{ id: 'rize-original', from: 'sherryl@example.test', subject: 'Dry run', at: new Date(at - 5 * 86400_000).toISOString(), body: 'Please confirm October 14 for the dry run. The slot is not confirmed.' }],
    flight: [{ id: 'flight-original', from: 'airline@example.test', subject: 'Arrival itinerary', at: new Date(at - 4 * 86400_000).toISOString(), body: 'Your flight arrives October 15 at 12:10 local time.' }],
  };
  const reads: string[] = [];
  const client = (account: OwnerProactivityAccount): GoogleClient => ({
    account: { connection_id: account.id, email: account.email },
    mailPage: async () => ({ messages: Object.entries(messages).map(([id, items]) => ({ id: items.at(-1)!.id, thread_id: id, from: items[0]!.from, subject: items[0]!.subject, snippet: 'short snippet cannot establish the obligation', at: items[0]!.at })), next_page_token: null, result_size_estimate: 3 }),
    threadPage: async (id: string) => { reads.push(`${account.id}:${id}`); return { messages: messages[id] ?? [], cursor: null }; },
  } as unknown as GoogleClient);
  const clients = new Map<string, GoogleClient>();
  const model = vi.fn(async (instruction: string, input: any, _schema?: object, _current?: () => Promise<void>) => {
    if (instruction.startsWith('Discover')) return JSON.stringify({ candidates: input.sources.map((source: any) => ({ source_refs: [source.source_ref], title: `Check ${source.ref.resourceId}`, hypothesis: 'Check the full latest source before suggesting preparation; no owner commitment is implied.', check_at: now })) });
    const handled = input.full_current_sources.some((source: any) => JSON.stringify(source.value).includes('submission was received'));
    return JSON.stringify({ disposition: handled ? 'silent' : 'notify', rationale: handled ? 'The newer provider thread contains a submission receipt.' : 'Useful fresh information, with preparation distinct from a booking.', text: handled ? '' : 'This source suggests a useful check. No booking or message has been made.', batch_at: null });
  });
  const enqueue = vi.fn(async () => ({ state: 'delivered' as const, receiptRef: 'app-journal:usable-owner-projection' }));
  const make = (push?: Parameters<typeof createOwnerProactivity>[0]['push'], purpose?:'background'|'interactive') => createOwnerProactivity({push, purpose, sql, book, updates, loops, responsibilities, google: { client: async (_feature, _intent, guard, email) => { await guard?.(); const account = rows.find(row => row.email === email); return account ? clients.get(account.id) ?? client(account) : null; } }, accounts: async () => rows, assertOwnerCurrent: async () => { if (!ownerCurrent) throw new Error('owner revoked'); }, audience: async () => audience, timezone: () => 'UTC', now: () => now, transaction, prompt: model, enqueue });
  return { db, sql, book, loops, responsibilities, updates, messages, reads, model, enqueue, make, clients,
    advance: (value = 1000) => { now += value; }, setAccounts: (value: readonly OwnerProactivityAccount[]) => { rows = value; }, revokeOwner: () => { ownerCurrent = false; }, setAudience: (value: string) => { audience = value; }, now: () => now };
}

describe('actual owner proactivity serving adapter', () => {
  it('discovers the three screenshot scenarios in a general full-source sweep and delivers a usable owner result', async () => {
    const f = fixture(), adapter = f.make(); const result = await adapter.tick();
    expect(result.failures).toEqual([]); expect(result.delivered).toBe(3);
    expect(f.book.watches()).toHaveLength(3); expect(f.responsibilities.list()).toHaveLength(3);
    expect(f.responsibilities.list().every(row => row.intent.includes('no owner commitment'))).toBe(true);
    const discovery = f.model.mock.calls.find(([instruction]) => instruction.startsWith('Discover'))![1];
    expect(JSON.stringify(discovery)).toContain('November 2'); expect(JSON.stringify(discovery)).toContain('October 14'); expect(JSON.stringify(discovery)).toContain('12:10');
    expect(f.enqueue.mock.calls).toHaveLength(3);
    expect(f.loops.reviewDue('2026-11-01T10:00', 'UTC', f.now())).toEqual([]);
    expect(f.book.deliveries().every(row => row.state === 'delivered')).toBe(true);
    const durableReferences = f.sql.exec<{ value: string }>('SELECT value FROM owner_proactivity_adapter').toArray();
    expect(JSON.stringify(durableReferences)).not.toContain('return the completed form');
  });
  it('withholds an already-handled source after a newer full-thread reply without closing the owner goal', async () => {
    const f = fixture(); const quiet = f.book.policy(); f.book.updatePolicy(quiet.revision, { ...quiet, notificationWindows: [{ days: [6], start: '11:00', end: '12:00' }] });
    const adapter = f.make(); await adapter.tick(); expect(f.enqueue).not.toHaveBeenCalled();
    f.messages.form = [...f.messages.form!, { id: 'new-receipt', from: 'school@example.test', subject: 'Re: Winter form', at: new Date(at + 30 * 60_000).toISOString(), body: 'Your submission was received. No further action is needed.' }];
    f.advance(60 * 60_000); await adapter.tick();
    const form = f.book.watches().find(watch => f.responsibilities.get(watch.responsibilityId)!.title === 'Check form')!;
    expect(f.book.deliveries().filter(row => row.watchId === form.id).some(row => row.reason === 'source_changed')).toBe(true);
    expect(f.book.deliveries().filter(row => row.watchId === form.id).some(row => row.state === 'silent')).toBe(true);
    expect(f.responsibilities.get(form.responsibilityId)!.status).toBe('open');
  });
  it('does not resend unchanged source occurrences on a later fallback or process restart', async () => {
    const f = fixture(); await f.make().tick(); expect(f.enqueue).toHaveBeenCalledTimes(3);
    f.advance(3600_000); const restarted = f.make(); restarted.recover(); await restarted.tick();
    expect(f.enqueue).toHaveBeenCalledTimes(3); expect(f.book.watches()).toHaveLength(3);
  });
  it('rejects owner, audience, account-grant and manual completion changes at the final delivery boundary', async () => {
    for (const change of ['owner', 'audience', 'grant', 'completion'] as const) {
      const f = fixture(); f.enqueue.mockImplementation(async () => ({ state: 'queued', receiptRef: 'existing-outbox' }) as any);
      const adapter = f.make(); await adapter.tick(); const row = f.book.deliveries()[0]!;
      f.advance();
      if (change === 'owner') f.revokeOwner();
      if (change === 'audience') f.setAudience('owner:work-group');
      if (change === 'grant') f.setAccounts([{ ...accountRow(), revision: 'grant-2', connected: false }]);
      if (change === 'completion') f.loops.close(row.responsibilityId, 'done');
      const eligible = await adapter.deliveryEligible(row.id).catch(() => false);
      expect(eligible, change).toBe(false);
      expect(f.responsibilities.get(row.responsibilityId)!.closed_by_evidence).toBeNull();
    }
  });
  it('records lost delivery acknowledgements as unknown and never retries them as a new send', async () => {
    const f = fixture(); f.enqueue.mockImplementation(async () => { throw new Error('lost ACK'); });
    await f.make().tick(); expect(f.book.deliveries().filter(row => row.state === 'unknown')).toHaveLength(3);
    f.advance(3600_000); const restarted = f.make(); restarted.recover(); await restarted.tick(); expect(f.enqueue).toHaveBeenCalledTimes(3);
  });
  it('readmits a genuine regrant as fresh discovery while revoked watches remain cancelled', async () => {
    const f = fixture(), adapter = f.make(); await adapter.tick();
    const old = f.book.watches().map(row => row.id);
    f.advance(); f.setAccounts([{ ...accountRow(), revision: 'revoked-2', connected: false }]); await adapter.tick();
    expect(f.book.watches().filter(row => old.includes(row.id)).every(row => row.state === 'cancelled')).toBe(true);
    const modelCalls = f.model.mock.calls.filter(([instruction]) => instruction.startsWith('Discover')).length;
    f.advance(); f.setAccounts([{ ...accountRow(), revision: 'regrant-3' }]); await adapter.tick();
    expect(f.model.mock.calls.filter(([instruction]) => instruction.startsWith('Discover')).length).toBe(modelCalls + 1);
    expect(f.book.watches().filter(row => old.includes(row.id)).every(row => row.state === 'cancelled')).toBe(true);
    expect(f.book.watches().filter(row => row.state === 'active')).toHaveLength(3);
  });
  it('rejects unchanged source bodies when a grant epoch changes during discovery judgment', async () => {
    const f = fixture(), original = f.model.getMockImplementation()!;
    f.model.mockImplementationOnce(async (instruction, input) => {
      f.setAccounts([{ ...accountRow(), revision: 'new-grant-after-revoke' }]);
      return original(instruction, input);
    });
    const result = await f.make().tick();
    expect(result.failures).toContainEqual(expect.objectContaining({ stage: 'discovery', code: 'source_revoked' }));
    expect(f.book.watches()).toEqual([]);
    expect(f.enqueue).not.toHaveBeenCalled();
    f.advance();
    await f.make().tick();
    expect(f.book.watches().filter(row => row.state === 'active')).toHaveLength(3);
  });
  it('gives the model host a fresh source guard and discards a decision after owner completion', async () => {
    const f = fixture(), original = f.model.getMockImplementation()!;
    f.model.mockImplementation(async (instruction, input, _schema, guard) => {
      expect(guard).toBeTypeOf('function');
      await guard!();
      const result = await original(instruction, input);
      if (!instruction.startsWith('Discover')) f.loops.close(input.watch.responsibilityId, 'done');
      return result;
    });
    const result = await f.make().tick();
    expect(result.failures.filter(row => row.stage === 'watch')).toHaveLength(3);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.book.deliveries()).toEqual([]);
  });
  it('uses every permitted Calendar and Tasks list, plus a Gmail-only second account, without relabeling their sources', async () => {
    const f = fixture(); f.setAccounts([{ ...accountRow('work'), features: { calendar: true, calendar_list: true, tasks: true } }, accountRow('personal')]);
    const workAccount = { connection_id: 'work', email: 'work@example.test' };
    f.clients.set('work', { account: workAccount,
      calendarListsPage: async (_n: number, _hidden: boolean, token?: string) => ({ items: [{ id: token ? 'team' : 'primary' }], next_page_token: token ? null : 'next-calendar', account: workAccount }),
      taskListsPage: async (_n: number, token?: string) => ({ items: [{ id: token ? 'projects' : 'personal-tasks' }], next_page_token: token ? null : 'next-tasks', account: workAccount }),
      calendarPage: async () => ({ events: [], next_page_token: null, account: workAccount }),
      tasksPage: async (list: string) => ({ tasks: [], next_page_token: null, task_list_ids: [list], account: workAccount }),
      changedEventsPage: async (id: string) => ({ events: [], next_page_token: null, calendar_id: id, account: workAccount }),
    } as unknown as GoogleClient);
    const adapter = f.make(); expect(await adapter.sources()).toEqual([
      { source: 'calendar', accountId: 'work', collection: 'primary' }, { source: 'calendar', accountId: 'work', collection: 'team' },
      { source: 'tasks', accountId: 'work', collection: 'personal-tasks' }, { source: 'tasks', accountId: 'work', collection: 'projects' },
      { source: 'mail', accountId: 'personal', collection: 'inbox' },
    ]);
    await adapter.tick(); expect(f.book.watches().every(watch => watch.sources.some(source => source.accountId === 'personal' && source.source === 'mail') && watch.sources.filter(source => source.source !== 'mail').every(source => source.accountId === 'work' && ['calendar', 'tasks'].includes(source.source)))).toBe(true);
    expect(f.updates.since('calendar_since', JSON.stringify(['work', 'team']))).toBe(at);
    expect(f.updates.since('mail_since', 'personal')).toBe(at);
    expect(f.updates.since('mail_since', 'work')).toBeNull();
  });
  it('resumes an unfinished list inventory after restart without advertising partial coverage', async () => {
    const f = fixture(); f.setAccounts([{ ...accountRow('work'), features: { tasks: true } }]);
    const tokens: (string | undefined)[] = [];
    f.clients.set('work', { account: { connection_id: 'work', email: 'work@example.test' }, taskListsPage: async (_n: number, token?: string) => { tokens.push(token); const page = Number(token ?? 0); return { items: [{ id: `list-${page}` }], next_page_token: page === 5 ? null : String(page + 1), account: { connection_id: 'work', email: 'work@example.test' } }; } } as unknown as GoogleClient);
    expect(await f.make().sources()).toEqual([]);
    expect(await f.make().sources()).toHaveLength(6);
    expect(tokens).toEqual([undefined, '1', '2', '3', '4', '5']);
  });
  it('continues Gmail-only discovery when another account cannot enumerate its Tasks lists', async () => {
    const f = fixture(); f.setAccounts([{ ...accountRow('work'), features: { tasks: true } }, accountRow('personal')]);
    f.clients.set('work', { account: { connection_id: 'work', email: 'work@example.test' }, taskListsPage: async () => { throw new Error('provider unavailable'); } } as unknown as GoogleClient);
    const result = await f.make().tick();
    expect(result.delivered).toBe(3); expect(result.failures).toContainEqual({ stage: 'discovery', id: '["work","tasks"]', code: 'inventory_unavailable' });
  });
  it('blocks a frozen mail nudge after a matching Calendar event arrives, even if the mail thread is unchanged', async () => {
    const f = fixture(); f.setAccounts([{ ...accountRow('work'), features: { calendar: true }, calendarIds: ['team'] }, accountRow('personal')]);
    const account = { connection_id: 'work', email: 'work@example.test' };
    let events: any[] = [];
    f.clients.set('work', { account, calendarPage: async () => ({ events, next_page_token: null, account }), changedEventsPage: async (id: string) => ({ events: [], next_page_token: null, calendar_id: id, account }) } as unknown as GoogleClient);
    f.enqueue.mockImplementation(async () => ({ state: 'queued', receiptRef: 'existing-outbox' }) as any);
    const adapter = f.make(); await adapter.tick();
    const frozen = f.book.deliveries().find(row => f.responsibilities.get(row.responsibilityId)!.title === 'Check rize')!;
    expect(frozen.sources).toContainEqual(expect.objectContaining({ source: 'calendar', accountId: 'work', collection: 'team' }));
    f.advance(); events = [{ id: 'confirmed-rize', title: 'Dry run confirmed', start: '2026-10-14T10:00:00Z', end: '2026-10-14T11:00:00Z', all_day: false }];
    expect(await adapter.deliveryEligible(frozen.id)).toBe(false);
    expect(f.book.deliveries().find(row => row.id === frozen.id)!.state).toBe('sending');
  });
  it('keeps verification artifacts out of the model source text and the reference ledger', async () => {
    const f = fixture(); f.messages.form = [{ ...f.messages.form![0]!, subject: 'Your verification code: 123456', body: 'Your one-time password is 123456. The form is due November 2.' }];
    await f.make().tick();
    const inputs = JSON.stringify(f.model.mock.calls.map(row => row[1]));
    expect(inputs).not.toContain('123456'); expect(inputs).toContain('November 2');
    expect(JSON.stringify(f.sql.exec('SELECT * FROM owner_proactivity_adapter').toArray())).not.toContain('123456');
  });
  it('honors processing windows independently of notification windows and keeps batched work durable', async () => {
    const f = fixture(), prior = f.book.policy();
    f.book.updatePolicy(prior.revision, { ...prior, processingWindows: [{ days: [6], start: '11:00', end: '12:00' }], notificationWindows: [{ days: [6], start: '13:00', end: '14:00' }] });
    await f.make().tick(); expect(f.reads).toEqual([]); expect(f.model).not.toHaveBeenCalled();
    f.advance(3600_000); await f.make().tick(); expect(f.book.deliveries().filter(row => row.state === 'held')).toHaveLength(3); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('honors existing owner follow-up opt-out before provider reads and rechecks it before queued delivery', async () => {
    const f = fixture();
    f.loops.setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal', followups: false });
    await f.make().tick(); expect(f.reads).toEqual([]); expect(f.model).not.toHaveBeenCalled();
    f.loops.setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal', followups: true });
    f.enqueue.mockImplementation(async () => ({ state: 'queued' }) as any);
    const adapter = f.make(); await adapter.tick(); const frozen = f.book.deliveries()[0]!;
    f.loops.setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal', followups: false });
    expect(await adapter.deliveryEligible(frozen.id)).toBe(false);
    expect(f.book.watches().filter(row => row.state === 'active')).toHaveLength(3);
  });
  it('does not enumerate a work account outside its processing window while personal discovery remains usable', async () => {
    const f = fixture(); f.setAccounts([{ ...accountRow('work'), features: { tasks: true } }, accountRow('personal')]);
    const enumerate = vi.fn(async () => { throw new Error('must not read outside the account window'); });
    f.clients.set('work', { account: { connection_id: 'work', email: 'work@example.test' }, taskListsPage: enumerate } as unknown as GoogleClient);
    const policy = f.book.accountPolicy('work');
    f.book.updateAccountPolicy('work', policy.revision, { ...policy, processingWindows: [{ days: [6], start: '11:00', end: '12:00' }] });
    const result = await f.make().tick();
    expect(enumerate).not.toHaveBeenCalled(); expect(result.delivered).toBe(3);
    expect(f.book.sourceAccess().every(row => row.accountId === 'personal')).toBe(true);
  });
  it('keeps volume-low preparation quiet and respects legacy quiet hours at the final send boundary', async () => {
    const f = fixture(); f.loops.setProactivity({ quiet_start: null, quiet_end: null, volume: 'low' });
    const adapter = f.make(); await adapter.tick(); expect(f.model).toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
    f.loops.setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal' });
    f.enqueue.mockImplementation(async () => ({ state: 'queued' }) as any);
    f.advance(); await adapter.tick(); const row = f.book.deliveries().find(row => row.state === 'sending')!;
    f.loops.setProactivity({ quiet_start: '09:00', quiet_end: '12:00', volume: 'normal' });
    expect(await adapter.deliveryEligible(row.id)).toBe(false);
  });
  it('fences a changed processing regime even when both old and new policies permit the current clock', async () => {
    const f = fixture(), original = f.model.getMockImplementation()!;
    f.model.mockImplementationOnce(async (instruction, input, _schema, guard) => {
      const policy = f.book.accountPolicy('personal');
      f.book.updateAccountPolicy('personal', policy.revision, { ...policy, processingWindows: [{ days: [6], start: '09:00', end: '12:00' }] });
      await expect(guard!()).rejects.toThrow();
      return original(instruction, input);
    });
    const result = await f.make().tick();
    expect(result.failures).toContainEqual(expect.objectContaining({ stage: 'discovery', code: 'source_revoked' }));
    expect(f.book.watches()).toEqual([]); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('does not overwrite an owner-corrected loop when its source is regranted', async () => {
    const f = fixture(), adapter = f.make(); await adapter.tick();
    const original = f.loops.list()[0]!;
    const corrected = f.loops.open({ title: 'Owner corrected preparation', due: '2026-11-01T12:00', source_ref: original.source_ref! });
    f.advance(); f.setAccounts([{ ...accountRow(), revision: 'revoked', connected: false }]); await adapter.tick();
    f.advance(); f.setAccounts([{ ...accountRow(), revision: 'regranted' }]); await adapter.tick();
    expect(f.loops.list().find(row => row.id === corrected.id)).toMatchObject({ title: corrected.title, due: corrected.due });
  });
  it('keeps waiting responsibilities checkable and removes watches only after evidenced owner closure', async () => {
    const f = fixture(); f.enqueue.mockImplementation(async () => ({ state: 'queued' }) as any);
    const adapter = f.make(); await adapter.tick(); const watch = f.book.watches()[0]!;
    f.sql.exec("UPDATE responsibilities SET status = 'waiting' WHERE id = ?", watch.responsibilityId);
    expect(await adapter.deliveryEligible(f.book.deliveries().find(row => row.watchId === watch.id)!.id)).toBe(true);
    f.responsibilities.close({ id: watch.responsibilityId, outcome: 'done', evidence_ref: 'owner:explicit-accepted-result' });
    f.advance(); await adapter.tick();
    expect(f.book.watch(watch.id)).toMatchObject({ state: 'satisfied', closureRef: 'owner:explicit-accepted-result' });
    expect(f.book.deliveries().filter(row => row.watchId === watch.id).every(row => row.state === 'unknown')).toBe(true);
  });
  it('applies per-account processing and notification policy through the registered owner tool and rejects stale or foreign targets', async () => {
    const f = fixture(), adapter = f.make();
    const tool = loopHandlers(f.loops, adapter.control).find(row => row.name === 'set_proactivity')!;
    const args = setProactivityArgsSchema.parse({ quiet_start: null, quiet_end: null, volume: 'normal', target: { scope: 'account', account_id: 'personal' }, policy_revision: 1,
      processing_windows: [{ days: [6], start: '11:00', end: '12:00' }], notification_windows: [{ days: [6], start: '13:00', end: '14:00' }] });
    expect(await (tool.handle as any)(args)).toMatchObject({ ok: true, data: { policy: { target: args.target, revision: 2 } } });
    await adapter.tick(); expect(f.reads).toEqual([]); expect(f.model).not.toHaveBeenCalled();
    expect(await (tool.handle as any)(args)).toMatchObject({ ok: false, code: 'rejected' });
    expect(await (tool.handle as any)({ ...args, target: { scope: 'account', account_id: 'another-owner-account' } })).toMatchObject({ ok: false, code: 'rejected' });
    expect(f.book.accountPolicy('another-owner-account').revision).toBe(1);
    f.advance(3600_000); await adapter.tick(); expect(f.book.deliveries().filter(row => row.state === 'held')).toHaveLength(3); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('keeps newer policy unavailable without a real serving control port and rejects a caller-selected owner', async () => {
    const f = fixture(), tool = loopHandlers(f.loops).find(row => row.name === 'set_proactivity')!;
    const args = setProactivityArgsSchema.parse({ quiet_start: null, quiet_end: null, volume: 'normal', processing_windows: [] });
    expect(await (tool.handle as any)(args)).toMatchObject({ ok: false, code: 'rejected' });
    expect(() => setProactivityArgsSchema.parse({ ...args, target: { scope: 'owner', owner_id: 'owner-b' } })).toThrow();
    expect(() => setProactivityArgsSchema.parse({ ...args, processing_windows: [{ days: [7], start: '25:00', end: '17:00' }] })).toThrow();
  });
  it('excludes revoked source-recovery hypotheses from subsequent active model personalization', async () => {
    const f = fixture(); f.setAccounts([accountRow('work'), accountRow('personal')]); const adapter = f.make(); await adapter.tick();
    const removed = f.book.watches().filter(row => row.sources.some(source => source.accountId === 'personal')).map(row => row.responsibilityId);
    f.advance(); f.setAccounts([accountRow('work'), { ...accountRow('personal'), connected: false, revision: 'revoked' }]);
    f.messages.form = [...f.messages.form!, { ...f.messages.form![0]!, id: 'new-source', body: 'The correct packet has been updated; preparation remains open.' }];
    await adapter.tick();
    const input = f.model.mock.calls.filter(([instruction]) => instruction.startsWith('Discover')).at(-1)![1];
    expect(input.responsibilities.every((row: any) => !removed.includes(row.id))).toBe(true);
    expect(f.responsibilities.all().filter(row => removed.includes(row.id))).toHaveLength(3);
  });
  it('does not accept model-selected account, audience, effect or unknown source authority', () => {
    const known = new Set(['source']);
    expect(() => parseDiscoveryCandidates(JSON.stringify({ candidates: [{ source_refs: ['other-account'], title: 'Check', hypothesis: 'Hypothesis', check_at: at }] }), known, at)).toThrow();
    expect(() => parseDiscoveryCandidates(JSON.stringify({ candidates: [{ source_refs: ['source'], title: 'Check', hypothesis: 'Hypothesis', check_at: at, approve: true }] }), known, at)).toThrow();
  });
});

describe('actual source subscription lifecycle with synthetic provider registration', () => {
  const config = {gmailTopic:'projects/waldo-project/topics/owner-inbox',calendarAddress:'https://receiver.example/google/calendar',calendarToken:async () => 'synthetic-existing-router-key-witness'};
  it('reports unavailable activation without a configured topic and preserves usable polling', async () => {
    const f=fixture(), adapter=f.make({...config,gmailTopic:undefined});
    expect(adapter.pushAvailability().mail).toBe('unavailable');
    const result=await adapter.tick(); expect(result.delivered).toBe(3);
    expect(result.failures).toContainEqual(expect.objectContaining({code:'source_push_unavailable'}));
  });
  it('renews Gmail watches with current read admission and authenticates exact account wake hints', async () => {
    const f=fixture(); const account={connection_id:'personal',email:'personal@example.test'};
    const baseline = {account, mailPage:async () => ({messages:Object.keys(f.messages).map(id=>({id,thread_id:id})),next_page_token:null}),threadPage:async(id:string) => ({messages:f.messages[id],cursor:null})};
    const watch=vi.fn(async(topic:string) => {expect(topic).toBe(config.gmailTopic);return {historyId:'100',expiration:f.now()+7*86400000};});
    f.clients.set('personal',{...baseline,watchMail:watch} as unknown as GoogleClient);
    const adapter=f.make(config); await adapter.tick(); expect(watch).toHaveBeenCalledTimes(1);
    expect(await adapter.gmailPush({connectionId:'personal',email:'foreign@example.test',historyId:'102',eventId:'push-1'})).toEqual({accepted:false,wakes:0});
    expect(await adapter.gmailPush({connectionId:'foreign',email:'personal@example.test',historyId:'102',eventId:'push-1'})).toEqual({accepted:false,wakes:0});
    expect(await adapter.gmailPush({connectionId:'personal',email:'personal@example.test',historyId:'102',eventId:'push-1'})).toEqual({accepted:true,wakes:3});
    f.advance(86400001); await adapter.tick(); expect(watch).toHaveBeenCalledTimes(2);
    f.setAccounts([{...accountRow(),revision:'revoked-2',connected:false}]);
    expect(await adapter.gmailPush({connectionId:'personal',email:'personal@example.test',historyId:'103',eventId:'push-2'})).toEqual({accepted:false,wakes:0});
  });
  it('keeps interrupted Calendar registration unknown across restart and never allocates a second channel until expiry', async () => {
    const f=fixture(); f.setAccounts([{...accountRow('work'),features:{calendar:true},calendarIds:['primary']}]);
    const watch=vi.fn(async () => {throw new Error('provider response lost');});
    f.clients.set('work',{account:{connection_id:'work',email:'work@example.test'},calendarPage:async()=>({events:[],next_page_token:null,account:{connection_id:'work',email:'work@example.test'}}),changedEventsPage:async()=>({events:[],next_page_token:null,calendar_id:'primary',account:{connection_id:'work',email:'work@example.test'}}),watchCalendarEvents:watch} as unknown as GoogleClient);
    const adapter=f.make(config); const result=await adapter.tick(); expect(result.failures).toContainEqual(expect.objectContaining({code:'source_push_outcome_unknown'}));
    expect(watch).toHaveBeenCalledTimes(1);
    f.advance(3600000); const restart=f.make(config); restart.recover(); await restart.tick(); expect(watch).toHaveBeenCalledTimes(1);
    const retained=JSON.stringify(f.sql.exec('SELECT value FROM owner_proactivity_adapter').toArray());
    expect(retained).toContain('unknown'); expect(retained).not.toContain('synthetic-existing-router-key-witness');
    f.advance(2*86400000); await restart.tick(); expect(watch).toHaveBeenCalledTimes(2);
  });
});

describe('manual authenticated source purpose remains independent of background scheduling',()=>{
  it('serves app-only current granted collections despite opt-out and processing windows without enabling notifications',async()=>{
    const f=fixture();f.setAccounts([{...accountRow('work'),features:{calendar:true,tasks:true},calendarIds:['team'],taskListIds:['projects']}]);
    f.loops.setProactivity({quiet_start:'09:00',quiet_end:'12:00',volume:'low',followups:false});
    const policy=f.book.accountPolicy('work');f.book.updateAccountPolicy('work',policy.revision,{...policy,processingWindows:[{days:[6],start:'11:00',end:'12:00'}]});
    const adapter=f.make();expect(await adapter.sources()).toEqual([]);
    const sources=await adapter.interactiveSources();expect(sources).toEqual([{source:'calendar',accountId:'work',collection:'team'},{source:'tasks',accountId:'work',collection:'projects'}]);
    const admitted=await adapter.interactiveAdmit(sources[0]!);expect(admitted).toMatchObject({ownerKey:'owner-a',available:true,connected:true});
    expect(await adapter.ports.admit(sources[0]!,'discovery')).toMatchObject({available:false});
    f.loops.setProactivity({quiet_start:null,quiet_end:null,volume:'normal',followups:true});
    expect((await adapter.interactiveAdmit(sources[0]!)).regime).toBe(admitted.regime);
    f.setAccounts([{...accountRow('work'),features:{calendar:true,tasks:true},calendarIds:['team'],taskListIds:['projects'],revision:'regranted-2'}]);
    expect((await adapter.interactiveAdmit(sources[0]!)).regime).not.toBe(admitted.regime);
    expect(await adapter.interactiveAdmit({...sources[0]!,collection:'foreign-calendar'})).toMatchObject({available:false,connected:false});
    f.setAccounts([{...accountRow('work'),features:{calendar:true,tasks:true},calendarIds:['team'],taskListIds:['projects'],connected:false,revision:'revoked'}]);
    expect(await adapter.interactiveSources()).toEqual([]);expect(await adapter.interactiveAdmit(sources[0]!)).toMatchObject({available:false,connected:false});
    expect(f.model).not.toHaveBeenCalled();expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('reports unknown unavailable inventory and known partial collections without claiming account completeness',async()=>{
    const f=fixture();f.setAccounts([{...accountRow('work'),features:{calendar:true,calendar_list:true,tasks:true}}]);
    const account={connection_id:'work',email:'work@example.test'};let page=0;
    f.clients.set('work',{account,calendarListsPage:async()=>({account,items:[{id:'team'}],next_page_token:`page-${++page}`}),taskListsPage:async()=>{throw new Error('inventory unavailable');}} as unknown as GoogleClient);
    const adapter=f.make(undefined,'interactive'),sources=await adapter.sources();expect(sources).toEqual([{source:'calendar',accountId:'work',collection:'team'}]);
    expect(adapter.inventoryCoverage()).toEqual([{source:'calendar',accountId:'work',collection:null,state:'partial',reason:'collection_inventory_incomplete'},{source:'tasks',accountId:'work',collection:null,state:'unavailable',reason:'collection_inventory_unavailable'}]);
    expect(await adapter.interactiveAdmit(sources[0]!)).toMatchObject({available:true});
    expect(await adapter.interactiveSources()).toEqual(sources);expect(page).toBe(4);
    expect(await adapter.interactiveAdmit({...sources[0]!,collection:'guessed'})).toMatchObject({available:false});
    await expect(adapter.tick()).rejects.toMatchObject({code:'not_available'});expect(f.enqueue).not.toHaveBeenCalled();
    f.revokeOwner();await expect(adapter.interactiveSources()).rejects.toThrow('owner revoked');
  });
});

describe('full current Gmail body consumption before source judgment',()=>{
 it('consumes later bounded body pages before discovery and fences regrant during continuation',async()=>{
  for(const revoked of [false,true]){const f=fixture(),account={connection_id:'personal',email:'personal@example.test'},body='x'.repeat(32000),tail='The form is due December 9. Owner preparation remains open.';
   const page=vi.fn(async()=>{if(revoked)f.setAccounts([{...accountRow(),revision:'new-grant'}]);return {message:{id:'message-1',from:'school@example.test',subject:'Form',at:'2026-10-10T09:00:00Z',body:tail},body_offset:32000,total_chars:body.length+tail.length,next_cursor:null,source_complete:true,attachments_omitted:false};});
   f.clients.set('personal',{account,mailPage:async()=>({messages:[{id:'message-1',thread_id:'form'}],next_page_token:null}),threadPage:async()=>({messages:[{id:'message-1',from:'school@example.test',subject:'Form',at:'2026-10-10T09:00:00Z',body,body_complete:false,body_cursor:'body-page-2'}],cursor:null}),messageBodyPage:page} as unknown as GoogleClient);
   const result=await f.make().tick();expect(page).toHaveBeenCalled();
   if(revoked){expect(f.model).not.toHaveBeenCalled();expect(f.book.watches()).toEqual([]);expect(result.failures).toContainEqual(expect.objectContaining({code:'source_revoked'}));}
   else{const discovery=f.model.mock.calls.find(([instruction])=>instruction.startsWith('Discover'))![1];expect(JSON.stringify(discovery)).toContain('December 9');expect(f.book.watches()).toHaveLength(1);expect(result.delivered).toBe(1);}
  }
 });
 it('withholds hypotheses when body continuation exhausts its budget or attachments remain omitted',async()=>{
  for(const attached of [false,true]){const f=fixture(),account={connection_id:'personal',email:'personal@example.test'};let page=0;
   f.clients.set('personal',{account,mailPage:async()=>({messages:[{id:'m',thread_id:'form'}],next_page_token:null}),threadPage:async()=>({messages:[{id:'m',from:'school@example.test',subject:'Form',at:'2026-10-10T09:00:00Z',body:'x',body_complete:attached,attachments_omitted:attached,...(!attached?{body_cursor:'body-1'}:{})}],cursor:null}),messageBodyPage:async(_thread:string,_message:string,cursor:string)=>{page++;const offset=Number(cursor.split('-')[1]);return {message:{id:'m',body:'x'},body_offset:offset,total_chars:100000,next_cursor:`body-${offset+1}`,source_complete:true,attachments_omitted:false};}} as unknown as GoogleClient);
   await f.make().tick();expect(f.model).not.toHaveBeenCalled();expect(f.book.watches()).toEqual([]);expect(f.enqueue).not.toHaveBeenCalled();expect(page).toBe(attached?0:40);
  }
 });
});
