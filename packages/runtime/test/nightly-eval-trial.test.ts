import { describe, expect, it } from 'vitest';
import { scriptedGateway, type ScriptRule } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { runTrial, type TrialScenario } from '../evals/nightly/trial';

const START = '2026-09-24T09:00:00+05:30';
const scenario = (steps: TrialScenario['steps'], world: TrialScenario['world'] = {}): TrialScenario => ({ id: 'trial-test', start: START, steps, world });
const trial = (item: TrialScenario, rules: readonly ScriptRule[], budget = callBudget(50)) => {
  const gateway = scriptedGateway({ rules });
  return { gateway, budget, result: runTrial(item, { gateway, budget }) };
};

describe('nightly eval trial', () => {
  it('records the promise, moves the clock and fires the reminder through the reminder path', async () => {
    const { result } = trial(scenario([{ say: 'Remind me at 5 to call the bank.' }, { advance_to: '2026-09-24T17:00:00+05:30' }, { fire_due: true }]), [
      { match: /Remind me at 5/, rounds: [{ toolCalls: [{ name: 'set_reminder', arguments: { note: 'call the bank', at: '2026-09-24T17:00', repeat: 'none' } }] }, { text: 'Set for 5pm.' }] },
      { match: /Reminder due now/, rounds: [{ text: 'Time to call the bank.' }] },
    ]);
    const run = await result;
    expect(run.status).toBe('ran');
    expect(run.transcript).toEqual([
      { role: 'owner', text: 'Remind me at 5 to call the bank.' },
      { role: 'waldo', text: 'Set for 5pm.\n\nDone: reminder set' },
      { role: 'world', text: 'The time is now 2026-09-24T17:00 (Asia/Kolkata).' },
      { role: 'world', text: 'The reminder "call the bank" fires.' },
      { role: 'waldo', text: 'Time to call the bank.' },
    ]);
    expect(run.tools).toEqual([{ name: 'set_reminder', ok: true }]);
    expect(run.effects).toEqual([{ kind: 'reminder.set', payload: { note: 'call the bank', at: '2026-09-24T17:00', repeat: 'none' } }]);
    expect(run.final_state).toMatchObject({ reminders: [{ note: 'call the bank', at: '2026-09-24T17:00', repeat: 'none', fired: true }] });
  });

  it('fires nothing before its time', async () => {
    const { result } = trial(scenario([{ say: 'Remind me at 5 to call the bank.' }, { fire_due: true }]), [
      { match: /Remind me at 5/, rounds: [{ toolCalls: [{ name: 'set_reminder', arguments: { note: 'call the bank', at: '2026-09-24T17:00', repeat: 'none' } }] }, { text: 'Set.' }] },
    ]);
    const run = await result;
    expect(run.transcript.map((turn) => turn.role)).toEqual(['owner', 'waldo']);
    expect(run.final_state).toMatchObject({ reminders: [{ fired: false }] });
  });

  it('serves mail search and threads from the synthetic world, and records drafts and send cards without sending', async () => {
    const world: TrialScenario['world'] = { mail: [{ id: 'm1', thread_id: 't1', from: 'Rail Desk <tickets@rail.example>', to: ['owner@example.com'], subject: 'Your train booking', body: 'Departs Pune 06:40 on 30 September.', at: '2026-09-23T10:00:00+05:30' }] };
    const { result } = trial(scenario([{ say: 'Find my train booking.' }], world), [{ match: /train booking/, rounds: [
      { toolCalls: [{ name: 'search_communication', arguments: { query: 'train booking', limit: 5 } }] },
      { toolCalls: [{ name: 'read_thread', arguments: { thread_id: 't1', limit: 5 } }] },
      { toolCalls: [{ name: 'draft_email', arguments: { to: ['tickets@rail.example'], subject: 'Re: Your train booking', body_markdown: 'Thanks.' } }] },
      { toolCalls: [{ name: 'send_email', arguments: { to: ['owner@example.com'], subject: 'Train', body_markdown: 'It departs 06:40.' } }] },
      { text: 'It departs at 06:40.' },
    ] }]);
    const run = await result;
    expect(run.tools).toEqual([{ name: 'search_communication', ok: true }, { name: 'read_thread', ok: true }, { name: 'draft_email', ok: true }, { name: 'send_email', ok: true }]);
    expect(run.effects.map((effect) => effect.kind)).toEqual(['mail.draft', 'mail.send.proposed']);
    expect(run.final_state).toMatchObject({ sent_mail: 0 });
  });

  it('finds nothing for a search the mail does not match', async () => {
    const world: TrialScenario['world'] = { mail: [{ id: 'm1', thread_id: 't1', from: 'Rail Desk <tickets@rail.example>', to: ['owner@example.com'], subject: 'Your train booking', body: 'Departs 06:40.', at: '2026-09-23T10:00:00+05:30' }] };
    const gateway = scriptedGateway({ rules: [{ match: /flight/, rounds: [{ toolCalls: [{ name: 'search_communication', arguments: { query: 'flight', limit: 5 } }] }, { text: 'None.' }] }] });
    const run = await runTrial(scenario([{ say: 'Any flight booking?' }], world), { gateway, budget: callBudget(50) });
    const output = run.toolOutputs.find((entry) => entry.name === 'search_communication')!.output;
    expect(output).toContain('"messages":[]');
  });

  it('keeps the conversation across a day for recall', async () => {
    const { gateway, result } = trial(scenario([{ say: 'My locker code at the gym is the blue one.' }, { advance_to: '2026-09-25T09:00:00+05:30' }, { say: 'Which locker did I say?' }]), [
      { match: /locker code/, rounds: [{ text: 'Noted.' }] },
      { match: /Which locker/, rounds: [{ text: 'The blue one.' }] },
    ]);
    await result;
    const last = gateway.requests().filter((request) => request.request.response_format?.name !== 'claim_ops').at(-1)!.request;
    expect(last.messages.map((message) => message.content).join('\n')).toContain('My locker code at the gym is the blue one.');
  });

  it('serves the synthetic calendar to the calendar read', async () => {
    const events = [{ id: 'e1', title: 'Design review', start: '2026-09-25T15:00:00+05:30', end: '2026-09-25T16:00:00+05:30' }];
    const gateway = scriptedGateway({ rules: [{ match: /tomorrow/, rounds: [
      { toolCalls: [{ name: 'query_calendar', arguments: { date_range: { from: '2026-09-25T00:00:00+05:30', to: '2026-09-26T00:00:00+05:30' } } }] }, { text: 'One meeting.' },
    ] }] });
    const run = await runTrial(scenario([{ say: "What's on tomorrow?" }], { events }), { gateway, budget: callBudget(50) });
    expect(run.tools).toEqual([{ name: 'query_calendar', ok: true }]);
    expect(run.toolOutputs[0]!.output).toContain('Design review');
  });

  it('keeps a standing order as the model set it, time included', async () => {
    const { result } = trial(scenario([{ say: 'Every weekday at 9, tell me my top emails.' }]), [{ match: /Every weekday/, rounds: [
      { toolCalls: [{ name: 'set_standing_order', arguments: { scope: 'Tell me my top emails', trigger: 'weekdays', at: '09:00', gate: 'act_and_report' } }] }, { text: 'Done.' },
    ] }]);
    expect((await result).final_state).toMatchObject({ standing_orders: [{ scope: 'Tell me my top emails', trigger: 'weekdays', at: '09:00', gate: 'act_and_report', escalation: 'message_owner' }] });
  });

  it('gives the model the shared health zones, then nothing once sharing is withdrawn', async () => {
    const { gateway, result } = trial(scenario([{ health: 'shared' }, { say: 'How is my body today?' }, { health: 'withdrawn' }, { say: 'And now?' }]), [
      { match: /How is my body/, rounds: [{ text: 'Steady.' }] },
      { match: /And now/, rounds: [{ text: 'Nothing shared.' }] },
    ]);
    const run = await result;
    const systems = gateway.requests().filter((request) => request.request.response_format?.name !== 'claim_ops').map((request) => request.request.system ?? '');
    expect(systems[0]).toContain('Form zone:');
    expect(systems.at(-1)).not.toContain('Form zone:');
    expect(systems.at(-1)).toContain('No derived health context is available');
    expect(run.transcript.filter((turn) => turn.role === 'world').map((turn) => turn.text)).toEqual(['The owner shares health data.', 'The owner withdraws health sharing.']);
  });

  it('stops as budget_exhausted when the model call budget runs out', async () => {
    const { result } = trial(scenario([{ say: 'one' }, { say: 'two' }]), [{ match: /one|two/, rounds: [{ text: 'ok' }] }], callBudget(1));
    const run = await result;
    expect(run.status).toBe('budget_exhausted');
  });

  it('starts every trial from a fresh world', async () => {
    const steps: TrialScenario['steps'] = [{ say: 'Remind me at 5 to call the bank.' }];
    const rules: ScriptRule[] = [{ match: /Remind/, rounds: [{ toolCalls: [{ name: 'set_reminder', arguments: { note: 'call the bank', at: '2026-09-24T17:00', repeat: 'none' } }] }, { text: 'Set.' }] }];
    const first = await trial(scenario(steps), rules).result;
    const second = await trial(scenario(steps), rules).result;
    expect(first.effects).toHaveLength(1);
    expect(second.effects).toHaveLength(1);
  });
});
