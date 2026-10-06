import { expect, it } from 'vitest';
import { syntheticCommandAdapter, type SyntheticObservation } from '../src/channels/browser-synthetic-commands';
const facts = (): SyntheticObservation => ({ url: 'https://fixture.example/form', text: 'Synthetic form', elements: [{ ref: 'value', tag: 'input', type: 'text', field: 'value', inForm: true }, { ref: '#submit', tag: 'button', type: 'submit', inForm: true }, { ref: 'plain', tag: 'button', type: 'button', inForm: false }], form: { action: 'https://fixture.example/submit', method: 'POST', values: { value: 'synthetic' } } });
const fixture = () => {
  let state = facts(), effects = 0, alive = false;
  const driver = syntheticCommandAdapter({ origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: 'run-one', submitRef: '#submit', transport: {
    start: async () => { alive = true; return 'private-id'; }, observe: async () => structuredClone(state), execute: async () => { effects++; }, close: async () => { alive = false; }, absent: async () => !alive, verify: async () => null,
  } });
  return { driver, set: (next: SyntheticObservation) => { state = next; }, state: () => state, effects: () => effects };
};
it('host facts hold submit/default buttons and Enter before any effect, ignoring model read intent and labels', async () => {
  const f = fixture(), id = await f.driver.start(600000), observed = await f.driver.inspect(id);
  for (const command of [{ operation: 'click', element_ref: '#submit', intent: 'read' }, { operation: 'type', element_ref: 'value', key: 'Enter' }]) {
    expect(await f.driver.command(id, command, observed.stateDigest, async () => {})).toMatchObject({ held: true });
  }
  expect(f.effects()).toBe(0);
  const changed = f.state(); f.set({ ...changed, elements: changed.elements.map((element, i) => i === 1 ? { ...element, type: '' } : element) });
  expect(await f.driver.command(id, { operation: 'click', element_ref: '#submit' }, (await f.driver.inspect(id)).stateDigest, async () => {})).toMatchObject({ held: true });
  expect(f.effects()).toBe(0);
});
it('plain button and link execute under bounded reads, model send widens a hold, and password input is refused', async () => {
  const f = fixture(), id = await f.driver.start(600000);
  let digest = (await f.driver.inspect(id)).stateDigest;
  expect(await f.driver.command(id, { operation: 'click', element_ref: 'plain' }, digest, async () => {})).toEqual({ held: false });
  expect(f.effects()).toBe(1);
  expect(await f.driver.command(id, { operation: 'click', element_ref: 'plain', intent: 'send' }, digest, async () => {})).toMatchObject({ held: true });
  const changed = f.state(); f.set({ ...changed, elements: [...changed.elements, { ref: 'link', tag: 'a', href: 'https://fixture.example/form', inForm: false }] });
  digest = (await f.driver.inspect(id)).stateDigest;
  expect(await f.driver.command(id, { operation: 'click', element_ref: 'link' }, digest, async () => {})).toEqual({ held: false });
  f.set({ ...changed, elements: changed.elements.map((element, i) => i === 0 ? { ...element, type: 'password' } : element) });
  await expect(f.driver.command(id, { operation: 'type', element_ref: 'value', value: 'secret' }, digest, async () => {})).rejects.toThrow();
  expect(f.effects()).toBe(2);
});
it('closed commands reject arbitrary code, storage, cookies, IDs and off-site navigation before transport effects', async () => {
  const f = fixture(), id = await f.driver.start(600000), observed = await f.driver.inspect(id);
  for (const command of [{ operation: 'evaluate', script: 'x' }, { operation: 'read', cookies: true }, { operation: 'read', session_id: 'private-id' }, { operation: 'wait', milliseconds: 1001 }, { operation: 'type', element_ref: 'value', value: 'x', key: 'Enter' }, { operation: 'goto', url: 'https://evil.example/form' }]) {
    await expect(f.driver.command(id, command, observed.stateDigest, async () => {})).rejects.toThrow();
  }
  expect(f.effects()).toBe(0);
  expect(await f.driver.inspect(id)).toMatchObject({ text: 'Synthetic form', elements: [{ ref: 'value' }, { ref: '#submit' }, { ref: 'plain' }], action: { url: 'https://fixture.example/submit', method: 'POST', fields: ['value'] } });
});
it('reobserves facts after async authority and refuses stale effects', async () => {
  const f = fixture(), id = await f.driver.start(600000), observed = await f.driver.inspect(id);
  await expect(f.driver.command(id, { operation: 'click', element_ref: 'plain' }, observed.stateDigest, async () => { const changed = f.state(); f.set({ ...changed, form: { ...changed.form, values: { value: 'drifted' } } }); })).rejects.toThrow('changed');
  expect(f.effects()).toBe(0);
});
it('aborts every page write except the exact once-approved target/body and re-vets redirects', async () => {
  let policy!: (request: { url: string; method: string; body?: string }) => boolean;
  let approved = false, writes = 0;
  const state = facts();
  const driver = syntheticCommandAdapter({ origin: 'https://fixture.example', pageUrl: state.url, runId: 'run-one', submitRef: '#submit', transport: {
    start: async (_ttl, gate) => { policy = gate; return 'id'; }, observe: async () => state, close: async () => {}, absent: async () => true, verify: async () => null,
    execute: async (_id, _command, _digest, before) => {
      await before();
      for (const request of [{ url: state.form.action, method: 'PUT', body: 'value=synthetic' }, { url: state.form.action, method: 'DELETE' }, { url: 'https://fixture.example/wrong', method: 'POST', body: 'value=synthetic' }, { url: state.form.action, method: 'POST', body: 'value=changed' }, { url: state.form.action, method: 'POST', body: 'value=synthetic&value=synthetic' }]) expect(policy(request)).toBe(false);
      if (policy({ url: state.form.action, method: 'POST', body: 'value=synthetic' })) writes++;
      expect(policy({ url: state.form.action, method: 'POST', body: 'value=synthetic' })).toBe(false);
      expect(policy({ url: 'https://evil.example/redirect', method: 'GET' })).toBe(false);
    },
  } });
  const id = await driver.start(600000), snapshot = await driver.inspect(id);
  expect(policy({ url: state.form.action, method: 'POST', body: 'value=synthetic' })).toBe(false);
  approved = true; await driver.submit(id, snapshot.stateDigest, async () => {}, undefined, () => { if (!approved) throw Error('revoked'); });
  expect(writes).toBe(1);
  expect(policy({ url: state.form.action, method: 'POST', body: 'value=synthetic' })).toBe(false);
  approved = false; await expect(driver.submit(id, snapshot.stateDigest, async () => {}, undefined, () => { if (!approved) throw Error('revoked'); })).rejects.toThrow('revoked');
  expect(writes).toBe(1);
});
it('requires physical close and exact absence, including an uncertain cleanup', async () => {
  let present = true, closes = 0;
  const driver = syntheticCommandAdapter({ origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: 'run-one', submitRef: '#submit', transport: { start: async () => 'id', observe: async () => facts(), execute: async () => {}, verify: async () => null, close: async () => { closes++; }, absent: async () => !present } });
  await expect(driver.end('id')).rejects.toThrow('cleanup unresolved');
  present = false; await driver.end('id'); expect(closes).toBe(2);
});
it('existing task and approval ledger bridge rejects foreign owner, binds actual request facts and closes after unknown outcome', async () => {
  const { browserGate } = await import('../src/channels/browser-gate');
  const { fixtureDigest } = await import('../src/channels/public-fixture-browser');
  const f = fixture();
  let row: unknown = null, lock: Promise<unknown> = Promise.resolve(), approved = false, created: import('@waldo/contracts').BrowserTaskProposal | undefined, consumed = false;
  const gate = browserGate({ enabled: true, ownerId: 'owner', manifestDigest: `sha256:${'a'.repeat(64)}`, driver: f.driver, now: () => 100, newId: () => crypto.randomUUID(),
    store: { exclusive: work => { const next = lock.then(work); lock = next.catch(() => {}); return next; }, load: async () => row, save: async value => { row = structuredClone(value); } },
    admit: async (_operation, evidence) => evidence?.approvalRef && !approved ? null : 'current-owner-grant',
    approvals: { create: async proposal => { created = proposal; return 'existing-ledger-ref'; }, consume: async (owner, proposal, ref) => { if (owner !== 'owner' || proposal.id !== created?.id || ref !== 'existing-ledger-ref' || consumed) return false; consumed = true; approved = true; return true; } },
  });
  await expect(gate.command('foreign', { operation: 'read' })).rejects.toThrow('unavailable');
  expect(f.effects()).toBe(0);
  const read = await gate.command('owner', { operation: 'read' }); expect(read.held).toBe(false);
  const held = await gate.command('owner', { operation: 'click', element_ref: '#submit', intent: 'read' });
  expect(held.held).toBe(true); expect(created).toMatchObject({ request: { url: 'https://fixture.example/submit', method: 'POST', fields: ['value'] }, binding: { value: 'synthetic' }, approvalExpiresAt: 600100 });
  expect(created!.actionDigest).toBe(await fixtureDigest({ url: created!.url, actionRef: '#submit', method: 'click', request: created!.request, binding: created!.binding }));
  await expect(gate.approve('foreign', created!.id, 'existing-ledger-ref')).rejects.toThrow('unavailable');
  expect(await gate.approve('owner', created!.id, 'existing-ledger-ref')).toMatchObject({ status: 'uncertain' });
  expect(row).toMatchObject({ phase: 'closed', submissionAttempted: true });
  const effects = f.effects();
  expect(await gate.approve('owner', created!.id, 'existing-ledger-ref')).toMatchObject({ status: 'rejected' });
  expect(f.effects()).toBe(effects);
});
it.each(['submit', 'image'])('native input type=%s is held before DOM effects regardless of declared read', async type => {
  const f = fixture(), state = f.state();
  f.set({ ...state, elements: state.elements.map(element => element.ref === '#submit' ? { ...element, tag: 'input', type, field: 'value' } : element) });
  const id = await f.driver.start(600000), snapshot = await f.driver.inspect(id);
  expect(await f.driver.command(id, { operation: 'click', element_ref: '#submit', intent: 'read' }, snapshot.stateDigest, async () => {})).toMatchObject({ held: true });
  expect(f.effects()).toBe(0);
});
it('expiry during final observation fences physical submit and the exact approved network request', async () => {
  const { browserGate } = await import('../src/channels/browser-gate');
  let now = 100, row: import('@waldo/contracts').BrowserTaskCheckpoint | null = null, active = false, writes = 0, close = 0, finalGrants = 0;
  let policy!: (request: { url: string; method: string; body?: string }) => boolean;
  const state = facts();
  const driver = syntheticCommandAdapter({ origin: 'https://fixture.example', pageUrl: state.url, runId: 'run-one', submitRef: '#submit', transport: {
    start: async (_ttl, gate) => { active = true; policy = gate; return 'private-id'; },
    observe: async () => { if (row?.phase === 'submitting' && finalGrants >= 3) now = row.session.expiresAt; return state; },
    execute: async (_id, command, _digest, before, assertCurrent) => { await before(); assertCurrent?.(); if (command.operation === 'click' && policy({ url: state.form.action, method: 'POST', body: 'value=synthetic' })) writes++; },
    close: async () => { close++; active = false; }, absent: async () => !active, verify: async () => null,
  } });
  const gate = browserGate({ enabled: true, ownerId: 'owner', manifestDigest: `sha256:${'a'.repeat(64)}`, driver, now: () => now, newId: () => crypto.randomUUID(), store: { exclusive: work => work(), load: async () => row, save: async value => { row = structuredClone(value); } },
    admit: async (operation, evidence) => { if (operation === 'act' && evidence?.approvalRef) finalGrants++; return 'grant'; }, approvals: { create: async () => 'ledger', consume: async () => true },
  });
  const held = await gate.command('owner', { operation: 'click', element_ref: '#submit' });
  if (!held.held || 'reason' in held) throw Error('expected native hold');
  expect(await gate.approve('owner', held.proposal.id, held.approvalRef)).toMatchObject({ status: 'uncertain' });
  expect(writes).toBe(0); expect(close).toBe(1); expect(active).toBe(false);
  expect(row).toMatchObject({ phase: 'closed', submissionAttempted: true });
  expect(policy({ url: state.form.action, method: 'POST', body: 'value=synthetic' })).toBe(false);
});
it('a declared-send read holds without substituting or proposing a form submission', async () => {
  const { browserGate } = await import('../src/channels/browser-gate');
  const f = fixture(); let row: unknown = null, cards = 0;
  const gate = browserGate({ enabled: true, ownerId: 'owner', manifestDigest: `sha256:${'a'.repeat(64)}`, driver: f.driver, now: () => 100, newId: () => crypto.randomUUID(), admit: async () => 'grant',
    store: { exclusive: work => work(), load: async () => row, save: async value => { row = value; } }, approvals: { create: async () => { cards++; return 'ledger'; }, consume: async () => true },
  });
  expect(await gate.command('owner', { operation: 'read', intent: 'send' })).toMatchObject({ held: true, reason: 'declared_send_unsupported' });
  expect(cards).toBe(0); expect(row).toMatchObject({ phase: 'active', proposal: null });
  await gate.finishRun('owner'); expect(row).toMatchObject({ phase: 'closed' });
});
it('rejects a second or changed native submitter rather than substituting the configured button', async () => {
  const f = fixture(), state = f.state();
  f.set({ ...state, elements: [...state.elements, { ref: 'other-submit', tag: 'button', type: 'submit', inForm: true }] });
  const id = await f.driver.start(600000);
  await expect(f.driver.inspect(id)).rejects.toThrow('synthetic state rejected');
  expect(f.effects()).toBe(0);
});
