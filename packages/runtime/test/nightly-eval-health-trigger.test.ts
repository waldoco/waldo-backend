import { describe, expect, it } from 'vitest';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { failedReceipts } from '../evals/nightly/receipts';
import { SCENARIOS } from '../evals/nightly/scenarios';
import { runTrial } from '../evals/nightly/trial';

const scenario = SCENARIOS.find((entry) => entry.id === 'h1-health-change-card')!;
const decision = (over: Record<string, unknown>) => JSON.stringify({ kind: 'propose', action: 'move', item: 'e2', start: '2026-09-24T19:30', end: '2026-09-24T20:30', title: null, notify_guests: null, reason: 'Recovery is compromised today; a later class gives you an easier evening.', ...over });
const noOp = JSON.stringify({ kind: 'no_op', action: null, item: null, start: null, end: null, title: null, notify_guests: null, reason: '' });
const gatewayAnswering = (text: string) => scriptedGateway({ rules: [{ match: /Health-aware planning check/, rounds: [{ text }] }] });
const withdrawnFirst = { ...scenario, steps: [{ health: 'withdrawn' as const }, ...scenario.steps.slice(1)] };

// The trigger runs in the nightly world as it does on the owner object: the production module, the world's calendar and
// loops, the consented read of zone words, and the production responder for the one structured model call.
describe('the health trigger in the nightly world', () => {
  it('turns a recovery change before a demanding evening into one card, in zone words, with the receipts holding', async () => {
    const gateway = gatewayAnswering(decision({}));
    const record = await runTrial(scenario, { gateway, budget: callBudget(20) });
    expect(record.status).toBe('ran');
    expect(record.effects).toEqual([{ kind: 'calendar.change.proposed', payload: expect.objectContaining({ action: 'move', event_id: 'today-spin', reason: expect.stringContaining('Recovery is compromised') }) }]);
    expect(record.transcript.filter((turn) => turn.role === 'waldo')).toEqual([{ role: 'waldo', surface: 'notification', text: expect.stringContaining('Recovery is compromised') }]);
    const prompt = gateway.requests().map((request) => JSON.stringify(request)).find((text) => text.includes('Health-aware planning check'))!;
    expect(prompt).toContain('recovery compromised');
    expect(prompt).toContain('Before (2026-09-23): recovery solid');
    expect(prompt).toContain('Spin class with Dev');
    expect(prompt).not.toMatch(/31\.7|52\.6/);
    expect(failedReceipts(scenario.receipts ?? [], record)).toEqual([]);
  });

  it('proposes nothing when the model judges the change does not matter', async () => {
    const record = await runTrial(scenario, { gateway: gatewayAnswering(noOp), budget: callBudget(20) });
    expect(record.effects).toEqual([]);
    expect(record.transcript.some((turn) => turn.role === 'waldo')).toBe(false);
  });

  it('asks the model nothing, and raises nothing, when the owner has withdrawn health sharing', async () => {
    const gateway = gatewayAnswering(decision({}));
    const record = await runTrial(withdrawnFirst, { gateway, budget: callBudget(20) });
    expect(record.status).toBe('ran');
    expect(gateway.requests().filter((request) => JSON.stringify(request).includes('Health-aware planning check'))).toEqual([]);
    expect(record.effects).toEqual([]);
  });

  it('refuses a card whose guest-visible title carries a health word, and the receipts catch one that got through', async () => {
    const gateway = gatewayAnswering(decision({ action: 'create', item: null, start: '2026-09-24T12:30', end: '2026-09-24T13:30', title: 'Recovery block' }));
    const refused = await runTrial(scenario, { gateway, budget: callBudget(20) });
    expect(refused.effects).toEqual([]);
    const leaked = { ...refused, effects: [{ kind: 'calendar.change.proposed', payload: { action: 'create', title: 'Low recovery rest', reason: 'x' } }] };
    expect(failedReceipts(scenario.receipts ?? [], leaked)).toEqual([expect.stringContaining('guest-visible')]);
    const two = { ...refused, effects: [1, 2].map(() => ({ kind: 'calendar.change.proposed', payload: { action: 'cancel', event_id: 'today-spin', reason: 'x' } })) };
    expect(failedReceipts(scenario.receipts ?? [], two)).toEqual([expect.stringContaining('one card')]);
  });
});
