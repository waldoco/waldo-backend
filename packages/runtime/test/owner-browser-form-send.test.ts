import { expect, it, vi } from 'vitest';
import { ownerBrowserRuntime } from '../src/channels/owner-browser-runtime';
import type { BrowserSubmitProposal } from '../src/channels/approvals';
import { commonBrowserFixture, commonBrowserFixtureLoader } from './fixtures/common-browser-sdk';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
vi.mock('../src/channels/common-staging-registration', async load => ({ ...await load<object>(), commonBrowserSdk: () => commonBrowserFixtureLoader }));
let custody = 'b'.repeat(64);
vi.mock('../src/identity/common-owner-authority', () => ({ commonOwnerAuthority: () => ({ resolve: async () => ({ directoryOwnerId: '10000000-0000-0000-0000-000000000002', custodyDigest: custody }) }) }));

// The owner runtime's form send: the turn that registers browse_act with the desk's proposer gets a card, and the
// approval runs after that turn on the ordinary owner browser, under the owner's custody rather than a run lease.
// Every value is synthetic.
const ACTION = 'https://example.com/forms/fictional/formResponse';
function fixture(flag = '1') {
  commonBrowserFixture.reset(); commonBrowserFixture.form = true; custody = 'b'.repeat(64);
  commonBrowserFixture.formSend = { method: 'post', action: ACTION, enctype: 'application/x-www-form-urlencoded', file: false, secret: false, fields: [['entry.1', 'Yes']], answers: [{ label: 'Will you attend?', value: 'Yes' }] };
  const rows = new Map<string, any>([['do_name', 'interactive-owner'], ['telegram_subject', '81102']]); let alarm: number | null = null;
  const storage = { kv: { get: (key: string) => rows.get(key), put: (key: string, value: unknown) => rows.set(key, structuredClone(value)), list: ({ prefix }: { prefix: string }) => [...rows].filter(([key]) => key.startsWith(prefix)) }, transactionSync: <T>(work: () => T) => work(), getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } } as unknown as DurableObjectStorage;
  const scope = (id: string): RunEffectScope => ({ runId: id, attempt: id, deadline: Date.now() + 3_600_000, signal: new AbortController().signal, admit() {}, commit: work => work() });
  let active = scope('first');
  const env = { WALDO_ENVIRONMENT: 'staging', BROWSER: {}, BROWSER_FORM_SUBMIT: flag, OWNER_DO: { idFromName: () => ({ toString: () => 'physical' }) } } as never;
  const runtime = ownerBrowserRuntime({ env, storage, actualDoId: 'physical', activeScope: () => active });
  const fallback = { name: 'browse_page', handle: vi.fn(() => { throw Error('No provider fallback'); }) } as never;
  const context = () => ({ authenticatedUserId: 'trusted-local-owner', runScope: active, turnId: active.runId, toolCallId: crypto.randomUUID(), egressAllowlist: ['*'] }) as never;
  const proposals: BrowserSubmitProposal[] = [];
  const proposer = { propose: async (payload: BrowserSubmitProposal) => { proposals.push(payload); return 'p-1'; } };
  const url = 'https://example.com/a';
  const read = () => runtime.read(fallback).handle({ url, instruction: 'Read the form', retain_session: true }, context()) as Promise<any>;
  const send = (page: any) => runtime.act(fallback, proposer).handle({ url, task: 'Send the RSVP', max_actions: 1, session_handle: page.data.session_handle, command: { operation: 'click', element_ref: page.data.elements[0].ref, intent: 'send' } } as never, context()) as Promise<any>;
  return { runtime, fallback, proposer, proposals, read, send, finish: async () => { await runtime.finish(active); active = scope('second'); } };
}

it('the turn proposes; after it ends, the owner\'s approval sends once from the same live page', async () => {
  const f = fixture(), page = await f.read();
  expect(await f.send(page)).toMatchObject({ ok: true, data: { stopped: 'approval_pending', proposal_id: 'p-1' } });
  expect(commonBrowserFixture.posts).toEqual([]);
  await f.finish();
  expect(await f.runtime.submitApprovedForm(f.proposals[0]!)).toMatchObject({ status: 'verified_with_receipt' });
  expect(commonBrowserFixture.posts).toEqual(['entry.1=Yes']);
  expect(commonBrowserFixture.allocations).toBe(1);
});

it('an approval while a turn holds the browser, after the switch is turned off, or after the owner\'s custody changed sends nothing', async () => {
  const busy = fixture(), page = await busy.read(); await busy.send(page);
  expect(await busy.runtime.submitApprovedForm(busy.proposals[0]!)).toMatchObject({ status: 'rejected', message: expect.stringContaining('using the browser') });

  const off = fixture('0'), offPage = await off.read(); await off.send(offPage); await off.finish();
  expect(await off.runtime.submitApprovedForm(off.proposals[0]!)).toMatchObject({ status: 'rejected', message: expect.stringContaining('switched off') });

  const moved = fixture(), movedPage = await moved.read(); await moved.send(movedPage); await moved.finish();
  custody = 'c'.repeat(64);
  expect(await moved.runtime.submitApprovedForm(moved.proposals[0]!)).toMatchObject({ status: 'rejected' });
  expect(commonBrowserFixture.posts).toEqual([]);
});

it('browse_act tells the model how to send a form only when the desk\'s proposer is offered', () => {
  const f = fixture();
  expect(f.runtime.act(f.fallback, f.proposer).description).toContain('intent "send"');
  expect(f.runtime.act(f.fallback).description).not.toContain('intent "send"');
  expect(f.runtime.act(f.fallback).description).toContain('page sends are unsupported');
});
