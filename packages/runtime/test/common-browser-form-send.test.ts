import { beforeEach, expect, it } from 'vitest';
import { commonBrowserHost, type CommonBrowserGrant } from '../src/channels/common-browser-host';
import type { BrowserSubmitProposal } from '../src/channels/approvals';
import { commonBrowserFixture, commonBrowserFixtureLoader } from './fixtures/common-browser-sdk';

// An approval-gated form send through the owner's Cloudflare host, against the synthetic provider. The turn proposes a
// card; the POST leaves only when the owner's approval runs, after that turn, on the same live page. Every value is synthetic.
const ACTION = 'https://public-pages.fixture.invalid/forms/fictional/formResponse';
const FORM = { method: 'post', action: ACTION, enctype: 'application/x-www-form-urlencoded', file: false, secret: false,
  fields: [['entry.1', 'Yes'], ['entry.2', 'Ana'], ['fbzx', '-123']] as [string, string][],
  answers: [{ label: 'Will you attend?', value: 'Yes' }, { label: 'Your name', value: 'Ana' }] };

const fixture = (options: { proposer?: boolean } = {}) => {
  commonBrowserFixture.reset(); commonBrowserFixture.form = true;
  let turn = true, owner = true;
  const rows = new Map<string, unknown>(), proposals: BrowserSubmitProposal[] = [];
  const storage = { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), list: ({ prefix }: { prefix: string }) => [...rows].filter(([key]) => key.startsWith(prefix)) }, transactionSync: <T>(work: () => T) => work() } as unknown as DurableObjectStorage;
  const task = { taskId: 'fixture-task', revision: 1, sources: ['browser'] as const, ready: true, startRef: 'fixture-owner' };
  const grant: CommonBrowserGrant = { ref: 'fixture-grant', ownerId: 'fixture-owner', taskId: task.taskId, expiresAt: Date.now() + 60000, allowedOrigins: ['https://public-pages.fixture.invalid'], maxScreenshotBytes: 1024, lifetimeMs: 60000 };
  const config = { retainInteractions: true as true, binding: {} as never, loadSdk: commonBrowserFixtureLoader, grant: async () => grant, reserveAllocation: async () => {},
    assertGrantCurrent: async () => { if (!turn) throw Error('turn over'); }, assertHandoffCurrent: async () => { if (!owner) throw Error('owner changed'); } };
  const proposer = { propose: async (payload: BrowserSubmitProposal) => { proposals.push(payload); return `p-${proposals.length}`; } };
  const host = commonBrowserHost({ storage, config, ownerId: 'fixture-owner', source: () => task, assertCurrent: async () => { if (!turn) throw Error('turn over'); },
    deadline: () => Date.now() + 60000, now: Date.now, ...(options.proposer === false ? {} : { formSubmit: () => proposer }) });
  const ctx = { authenticatedUserId: 'fixture-owner', assertTaskSourceCurrent: async () => { if (!turn) throw Error('turn over'); } } as never;
  const record = () => rows.get('common-browser:fixture-task') as any;
  const read = async () => await host.handler.handle({ url: 'https://public-pages.fixture.invalid/a', instruction: 'Read the form.' }, ctx) as any;
  const act = (page: any, command: Record<string, unknown>) => host.actionHandler.handle({ url: page.data.url, task: 'Fill the form', max_actions: 1, command } as never, ctx) as Promise<any>;
  const send = (page: any) => act(page, { operation: 'click', element_ref: page.data.elements[0].ref, intent: 'send' });
  return { host, proposals, record, read, act, send, endTurn: () => { turn = false; }, ownerChanged: () => { owner = false; } };
};
beforeEach(() => { commonBrowserFixture.reset(); });

it('the turn gets a card built from the page\'s own form, and nothing leaves until the owner approves it after the turn', async () => {
  const f = fixture(); commonBrowserFixture.formSend = FORM;
  const page = await f.read();
  const proposed = await f.send(page);
  expect(proposed).toMatchObject({ ok: true, data: { stopped: 'approval_pending', proposal_id: 'p-1', answers: FORM.answers } });
  expect([commonBrowserFixture.effects, commonBrowserFixture.posts]).toEqual([0, []]);
  expect(f.proposals[0]).toMatchObject({ url: page.data.url, action: { description: 'Send this form', method: 'click' }, binding: { 'Will you attend?': 'Yes', 'Your name': 'Ana' },
    request: { url: ACTION, method: 'POST', fields: ['entry.1', 'entry.2', 'fbzx'] }, form: { taskId: 'fixture-task', sessionId: page.data.session_handle } });
  f.endTurn();
  const outcome = await f.host.submitApprovedForm(f.proposals[0]!);
  expect(outcome).toMatchObject({ status: 'verified_with_receipt' });
  expect(commonBrowserFixture.posts).toEqual(['entry.1=Yes&entry.2=Ana&fbzx=-123']);
  expect(f.record()).toMatchObject({ submit: { state: 'sent' }, action: { state: 'observed' }, observation: { observation: { url: ACTION } } });
  // The desk promotes the card to done only on this host's own receipt for that permit.
  if (outcome.status !== 'verified_with_receipt') throw Error('expected a receipt');
  expect(f.host.formReceiptVerified(f.proposals[0]!, outcome.receipt)).toBe(true);
  expect(f.host.formReceiptVerified(f.proposals[0]!, { ...outcome.receipt, binding_digest: '0'.repeat(64) })).toBe(false);
  expect(f.host.formReceiptVerified({ ...f.proposals[0]!, form: { ...f.proposals[0]!.form!, permitId: 'another-permit' } }, outcome.receipt)).toBe(false);
  // One card, one send: approving the same card again sends nothing more.
  expect(await f.host.submitApprovedForm(f.proposals[0]!)).toMatchObject({ status: 'rejected' });
  expect(commonBrowserFixture.posts).toHaveLength(1);
  await f.host.cancel();
});

it('the page may add a field at send time, but a changed answer on the wire is stopped in the browser and sends nothing', async () => {
  const f = fixture(); commonBrowserFixture.formSend = { ...FORM, sent: [...FORM.fields, ['dlut', '1']] };
  await f.send(await f.read()); f.endTurn();
  expect(await f.host.submitApprovedForm(f.proposals[0]!)).toMatchObject({ status: 'verified_with_receipt' });
  expect(commonBrowserFixture.posts).toHaveLength(1);
  const g = fixture(); commonBrowserFixture.formSend = { ...FORM, sent: [['entry.1', 'No'], ['entry.2', 'Ana'], ['fbzx', '-123']] };
  await g.send(await g.read()); g.endTurn();
  const refused = await g.host.submitApprovedForm(g.proposals[0]!);
  expect(refused).toMatchObject({ status: 'rejected' }); expect(refused.message).toContain('Nothing was sent');
  expect([commonBrowserFixture.posts, commonBrowserFixture.aborts]).toEqual([[], 1]);
  expect(g.record().submit.state).toBe('unsent');
});

it('a page that does not send, a page changed after the card, a withdrawn card or a changed owner sends nothing', async () => {
  const silent = fixture(); commonBrowserFixture.formSend = { ...FORM, silent: true };
  await silent.send(await silent.read()); silent.endTurn();
  expect(await silent.host.submitApprovedForm(silent.proposals[0]!)).toMatchObject({ status: 'rejected' });
  expect(silent.record()).toMatchObject({ submit: { state: 'unsent' }, action: { state: 'observed' } });

  const changed = fixture(); commonBrowserFixture.formSend = FORM;
  const page = await changed.read(); await changed.send(page);
  await changed.act(page, { operation: 'type', element_ref: page.data.elements[0].ref, value: 'Another note', intent: 'read' });
  changed.endTurn();
  expect(await changed.host.submitApprovedForm(changed.proposals[0]!)).toMatchObject({ status: 'rejected', message: expect.stringContaining('page changed') });

  const withdrawn = fixture(); commonBrowserFixture.formSend = FORM;
  await withdrawn.send(await withdrawn.read()); withdrawn.host.withdrawForm(withdrawn.proposals[0]!); withdrawn.endTurn();
  expect(await withdrawn.host.submitApprovedForm(withdrawn.proposals[0]!)).toMatchObject({ status: 'rejected' });

  const owner = fixture(); commonBrowserFixture.formSend = FORM;
  await owner.send(await owner.read()); owner.endTurn(); owner.ownerChanged();
  expect(await owner.host.submitApprovedForm(owner.proposals[0]!)).toMatchObject({ status: 'rejected' });
  expect(commonBrowserFixture.posts).toEqual([]);
});

it('a password or file form, a GET form, or a control outside a form gets no card', async () => {
  for (const [form, words] of [[{ ...FORM, secret: true }, 'password'], [{ ...FORM, file: true }, 'file'], [{ ...FORM, method: 'get' }, 'GET'], [undefined, 'not part of a form'],
    [{ ...FORM, enctype: 'multipart/form-data' }, 'another encoding'], [{ ...FORM, action: 'https://elsewhere.fixture.invalid/forms/x/formResponse' }, 'outside']] as const) {
    const f = fixture(); commonBrowserFixture.formSend = form as never;
    const refused = await f.send(await f.read());
    expect(refused, words).toMatchObject({ ok: false, code: 'rejected' }); expect(refused.error, words).toContain(words);
    expect(f.proposals, words).toEqual([]);
  }
});

it('without the switch a send stays refused before any page read, as before', async () => {
  const f = fixture({ proposer: false }); commonBrowserFixture.formSend = FORM;
  const refused = await f.send(await f.read());
  expect(refused).toMatchObject({ ok: false, code: 'rejected' });
  expect([f.proposals, commonBrowserFixture.posts, commonBrowserFixture.effects]).toEqual([[], [], 0]);
});
