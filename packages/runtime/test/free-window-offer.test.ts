import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { replyApprovalPartV1Schema, replyFreeWindowPartV1Schema } from '../../contracts/src/app/parts';
import { appApprovalParts, approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { appCaller } from '../src/channels/surfaces/app';
import { triageTools } from '../src/channels/update-sweep';
import type { GoogleClient } from '../src/connectors/google';

// A free-window offer is an ordinary calendar card the owner approves, labelled by what each answer does to the window; a build
// that reads chat revision 9 also gets the one-line form, which decides through the same approval. Synthetic times and tasks.
const NOW = Date.UTC(2026, 10, 9, 9, 0, 0);
const at = (ms: number) => new Date(ms).toISOString() as never;
const block = { action: 'create' as const, title: 'Finish the deck', start: at(NOW + 10 * 60_000), end: at(NOW + 55 * 60_000), block: 'deep_work' as const,
  reason: 'Your 3pm got cancelled. 45 minutes free: good slot to finish the deck?' };
const deskIn = (state: DurableObjectState) => approvalDesk(state.storage.sql, { owner: 7_000_000_000_001, surface: 'app', call: appCaller(), newId: (() => { let n = 0; return () => `fw${++n}`; })(),
  now: () => NOW, timezone: 'UTC', log: () => undefined, google: async () => ({}) as GoogleClient, currentRunRef: () => 'run-fw', effects: ownerEffectLedger(state.storage, () => NOW) });
const inObject = (work: (state: DurableObjectState) => Promise<void>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`free-window-${crypto.randomUUID()}`)), async (_i, state) => work(state));

describe('a free-window offer', () => {
  it('golden: one card, its line as the question and Do it / Not now / Keep it free as its answers; chat 9 adds the line form', () => inObject(async (state) => {
    const desk = deskIn(state);
    const id = await desk.propose({ ...block, offer: 'free_window' });
    const old = appApprovalParts(state.storage.sql)('run-fw');
    expect(old.live).toHaveLength(1);
    expect(old.offers).toBeUndefined();
    const [card] = old.live;
    expect(replyApprovalPartV1Schema.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({ approval_id: id, kind: 'calendar_change', question: block.reason, labels: { approve: 'Do it', defer: 'Not now', skip: 'Keep it free' } });
    const nine = appApprovalParts(state.storage.sql, undefined, 9)('run-fw');
    expect(nine.live).toEqual(old.live);
    expect(nine.offers).toEqual([{ type: 'free_window', approval_id: id, line: block.reason, start: NOW + 10 * 60_000, end: NOW + 55 * 60_000,
      choices: [{ action: 'approve', label: 'Do it' }, { action: 'defer', label: 'Not now' }, { action: 'skip', label: 'Keep it free' }],
      fallback_text: `${block.reason} Do it / Not now / Keep it free` }]);
    expect(replyFreeWindowPartV1Schema.safeParse(nine.offers![0]).success).toBe(true);
  }));

  it('a later window is a plain calendar card: no labels and no line form', () => inObject(async (state) => {
    const desk = deskIn(state);
    await desk.propose(block);
    const nine = appApprovalParts(state.storage.sql, undefined, 9)('run-fw');
    expect(nine.live[0]).not.toHaveProperty('labels');
    expect(nine.live[0]).not.toHaveProperty('question');
    expect(nine.offers).toBeUndefined();
  }));

  it('a decided offer is no longer a part in either form', () => inObject(async (state) => {
    const desk = deskIn(state);
    const id = await desk.propose({ ...block, offer: 'free_window' });
    await desk.decide(id, 's', 'test');
    const nine = appApprovalParts(state.storage.sql, undefined, 9)('run-fw');
    expect([nine.live, nine.offers]).toEqual([[], undefined]);
  }));

  it('a question past the contract\'s length is cut to fit, on one line', () => inObject(async (state) => {
    const desk = deskIn(state);
    await desk.propose({ ...block, offer: 'free_window', reason: `${'A long reason. '.repeat(15)}\nwith a second line` });
    const [card] = appApprovalParts(state.storage.sql, undefined, 9)('run-fw').live;
    expect(card!.question!.length).toBeLessThanOrEqual(120);
    expect(card!.question).not.toMatch(/\n/);
  }));
});

describe('the owner\'s limits hold offers like any card', () => {
  it('with the budget spent, quiet hours or the cooldown, triage has no card tool to offer with', () => {
    expect(triageTools(false, true)).toContain('propose_calendar_change');
    expect(triageTools(false, false)).not.toContain('propose_calendar_change');
  });
});
