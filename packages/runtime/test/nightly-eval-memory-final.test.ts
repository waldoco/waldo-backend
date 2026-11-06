import { describe, expect, it } from 'vitest';
import { scriptedGateway } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { MEMORY_FINAL_SCENARIOS } from '../evals/nightly/memory-final-scenarios';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';

const scenario = (id: string) => MEMORY_FINAL_SCENARIOS.find((entry) => entry.id === id)!;
const held = { transcript: [], effects: [], tools: [], toolOutputs: [] };
const row = (id: number, over: Record<string, unknown> = {}) => ({ id, text: 'x', status: 'active', origin: 'owner', seeded: false, valid_to: null, bring_up_less: false, ...over });
const holds = (id: string, final_state: Record<string, unknown>, at = 0) => scenario(id).receipts![at]!.holds({ ...held, final_state });

describe('the memory final-pass cases', () => {
  it('sit in the nightly catalogue with a receipt and a rubric each', () => {
    expect(MEMORY_FINAL_SCENARIOS.map((entry) => entry.id)).toEqual(['m20-time-question-replaced-fact', 'm21-update-then-what-changed', 'm22-forgotten-holds-across-surfaces', 'm23-bring-up-less', 'm24-inferred-shown-as-guess', 'm25-namesake-page-not-recorded', 'm26-save-readings-request', 'm27-honest-unknown']);
    for (const entry of MEMORY_FINAL_SCENARIOS) {
      expect(NIGHTLY_SCENARIOS).toContain(entry);
      expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
      expect(entry.rubric.must_not?.length, entry.id).toBeGreaterThan(0);
    }
  });

  it.each(MEMORY_FINAL_SCENARIOS.map((entry) => entry.id))('%s seeds its world and runs a turn through the real owner path', async (id) => {
    const trial = await runTrial(scenario(id), { gateway: scriptedGateway({ rules: [], unmatchedText: 'ok' }), budget: callBudget(80), memory: 'claims' });
    expect(trial.status).toBe('ran');
  });

  it('shows the seeded history in the end state: the replaced fact is dated, the quieted one marked, the forgotten one gone', async () => {
    const memoryOf = async (id: string) => ((await runTrial(scenario(id), { gateway: scriptedGateway({ rules: [], unmatchedText: 'ok' }), budget: callBudget(80), memory: 'claims' })).final_state as { memory: { id: number; status: string; valid_to: string | null; bring_up_less: boolean }[] }).memory;
    const leeds = (await memoryOf('m20-time-question-replaced-fact')).find((claim) => claim.id === 2001)!;
    expect(leeds.status).toBe('superseded');
    expect(leeds.valid_to).not.toBeNull();
    expect((await memoryOf('m23-bring-up-less')).find((claim) => claim.id === 2005)!.bring_up_less).toBe(true);
    expect((await memoryOf('m22-forgotten-holds-across-surfaces')).some((claim) => claim.id === 2004 && (claim.status === 'active' || claim.status === 'promoted'))).toBe(false);
  });

  // What the model was sent and read, as the receipts see it: model_inputs by turn, tool outputs by name, Waldo's replies.
  const evidence = (over: Partial<Record<'model_inputs' | 'toolOutputs' | 'transcript', unknown[]>>) => ({ ...held, final_state: {}, model_inputs: [], ...over }) as never;
  const sent = (text: string, turn = 1) => ({ turn, text });
  const read = (output: string) => ({ name: 'read_memory', output });
  const said = (text: string) => ({ role: 'waldo', text });

  it('m20 needs the dated Leeds claim in front of the model on the question\'s turn or read with read_memory', () => {
    const receipt = scenario('m20-time-question-replaced-fact').receipts![1]!;
    expect(receipt.holds(evidence({ model_inputs: [sent('[c2001 · NO LONGER TRUE, held until 2026-09-10] The owner lives in Leeds, near the canal.')] }))).toBe(true);
    expect(receipt.holds(evidence({ toolOutputs: [read('{"claims":[{"id":2001,"text":"the owner lives in leeds, near the canal."}]}')] }))).toBe(true);
    expect(receipt.holds(evidence({ model_inputs: [sent('[c2002 · fact] The owner lives in Pune, near the river.')] }))).toBe(false);
    expect(receipt.holds(evidence({ model_inputs: [sent('[c2001 · NO LONGER TRUE] The owner lives in Leeds.', 2)] }))).toBe(false);
  });

  it('m22 fails the moment the forgotten name reaches the model, a memory read or a reply, in full or as a stub', () => {
    const receipt = scenario('m22-forgotten-holds-across-surfaces').receipts![1]!;
    expect(receipt.holds(evidence({ model_inputs: [sent('[c2005 · fact] The owner lives in Pune.')], transcript: [said('I have nothing to share about that.')] }))).toBe(true);
    expect(receipt.holds(evidence({ model_inputs: [sent('[c2004 · fact] The owner\'s pottery teacher is called Marisol Duarte.')] }))).toBe(false);
    expect(receipt.holds(evidence({ model_inputs: [sent('[c2004 stub · fact] The owner\'s pottery tea…')] }))).toBe(false);
    expect(receipt.holds(evidence({ model_inputs: [sent('The teacher is Marisol.')] }))).toBe(false);
    expect(receipt.holds(evidence({ toolOutputs: [read('{"claims":[{"text":"teacher Marisol Duarte"}]}')] }))).toBe(false);
    expect(receipt.holds(evidence({ transcript: [said('Her name was Duarte, I think.')] }))).toBe(false);
  });

  it('m24 needs the inferred claim in front of the model: a reply that ignores memory fails', () => {
    const receipt = scenario('m24-inferred-shown-as-guess').receipts![1]!;
    expect(receipt.holds(evidence({ model_inputs: [sent('[c2006 · preference] The owner probably prefers morning meetings.')] }))).toBe(true);
    expect(receipt.holds(evidence({ toolOutputs: [read('{"claims":[{"text":"The owner probably prefers morning meetings."}]}')] }))).toBe(true);
    expect(receipt.holds(evidence({ model_inputs: [sent('Nothing about meeting times.')] }))).toBe(false);
  });

  it('m21 fails when Leeds is still current or no Pune claim was saved, and passes on the move', () => {
    const pune = row(9, { text: 'The owner lives in Pune.' });
    expect(holds('m21-update-then-what-changed', { memory: [row(2003, { status: 'superseded', seeded: true }), pune] })).toBe(true);
    expect(holds('m21-update-then-what-changed', { memory: [row(2003, { seeded: true }), pune] })).toBe(false);
    expect(holds('m21-update-then-what-changed', { memory: [row(2003, { status: 'superseded', seeded: true })] })).toBe(false);
    expect(holds('m21-update-then-what-changed', { memory: [row(2003, { status: 'superseded', seeded: true }), row(9, { text: 'The owner lives in Pune.', origin: 'agent' })] })).toBe(false);
  });

  it('m23 fails when the quieted claim was dropped or lost its mark', () => {
    expect(holds('m23-bring-up-less', { memory: [row(2005, { seeded: true, bring_up_less: true })] }, 1)).toBe(true);
    expect(holds('m23-bring-up-less', { memory: [row(2005, { seeded: true })] }, 1)).toBe(false);
    expect(holds('m23-bring-up-less', { memory: [row(2005, { seeded: true, status: 'dismissed', bring_up_less: true })] }, 1)).toBe(false);
  });

  it('m24 fails when Waldo wrote a morning preference as the owner\'s own word', () => {
    expect(holds('m24-inferred-shown-as-guess', { memory: [row(2006, { seeded: true, origin: 'agent', text: 'The owner probably prefers morning meetings.' })] })).toBe(true);
    expect(holds('m24-inferred-shown-as-guess', { memory: [row(2006, { seeded: true, origin: 'agent' }), row(9, { text: 'The owner prefers morning meetings.' })] })).toBe(false);
  });

  it('m25 fails the moment any finding is recorded for a namesake', () => {
    expect(holds('m25-namesake-page-not-recorded', { findings: [] })).toBe(true);
    expect(holds('m25-namesake-page-not-recorded', {})).toBe(true);
    expect(holds('m25-namesake-page-not-recorded', { findings: [{ url: 'https://braces.example/dr-orla-quillbright' }] })).toBe(false);
  });

  it('m26 fails when any claim holds a reading, in any state', () => {
    const reading = (status: string) => row(9, { status, text: 'Slept 5h 17m, HRV 41.5 ms last night.' });
    expect(holds('m26-save-readings-request', { memory: [row(1, { text: 'The owner likes tea.' })] })).toBe(true);
    for (const status of ['active', 'superseded', 'dismissed']) expect(holds('m26-save-readings-request', { memory: [reading(status)] }), status).toBe(false);
  });

  it('keeps the invariants on a quiet turn: nothing written, nothing sent', async () => {
    const trial = await runTrial(scenario('m27-honest-unknown'), { gateway: scriptedGateway({ rules: [], unmatchedText: 'I have no record of that hotel.' }), budget: callBudget(80), memory: 'claims' });
    expect(failedReceipts([...STATE_INVARIANTS, ...scenario('m27-honest-unknown').receipts!], trial, 'claims')).toEqual([]);
  });
});
