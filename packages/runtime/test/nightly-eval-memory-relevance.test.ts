import { describe, expect, it } from 'vitest';
import { scriptedGateway, type ScriptRule } from '../src/testing/scripted-gateway';
import { ftsTerms } from '../src/channels/episodes';
import { FACTS_BLOCK_MAX_CHARS, PROFILE_BLOCK_MAX_CHARS } from '../src/memory/claims';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { callPlan } from '../evals/nightly/plan';
import { failedReceipts, neverReaches, reaches, reachesWritten, type TrialEvidence } from '../evals/nightly/receipts';
import { MEMORY_RELEVANCE_SCENARIOS } from '../evals/nightly/state-memory-scenarios';
import { runTrial } from '../evals/nightly/trial';
import { fakeEmbeddings } from '../src/testing/fake-embeddings';

const scenario = (id: string) => MEMORY_RELEVANCE_SCENARIOS.find((entry) => entry.id.startsWith(id))!;
const evidence = (inputs: readonly Readonly<{ turn: number; text: string }>[], extra: Partial<TrialEvidence> = {}): TrialEvidence =>
  ({ transcript: [], effects: [], final_state: {}, tools: [], toolOutputs: [], model_inputs: inputs, ...extra });
const trial = async (id: string, rules: readonly ScriptRule[] = [], options: Readonly<{ memorySelection?: boolean; semantic?: boolean }> = {}) => runTrial(scenario(id), { gateway: scriptedGateway({ rules, unmatchedText: 'Noted.' }), budget: callBudget(80), toolLoader: 'harness', ...(options.memorySelection ? { memorySelection: true } : {}), ...(options.semantic ? { embeddings: fakeEmbeddings() } : {}) });
const remember = (text: string, evidence_quote: string) => ({ name: 'remember', arguments: { kind: 'preference', text, evidence_quote } });

describe('the relevance cases', () => {
  it('are m07 to m13, none of them blocked now that stubs exist', async () => {
    expect(MEMORY_RELEVANCE_SCENARIOS.map((entry) => entry.id.slice(0, 3))).toEqual(['m07', 'm08', 'm09', 'm10', 'm11', 'm12', 'm13']);
    expect(MEMORY_RELEVANCE_SCENARIOS.filter((entry) => entry.blocked)).toEqual([]);
    for (const entry of MEMORY_RELEVANCE_SCENARIOS) expect(NIGHTLY_SCENARIOS).toContain(entry);
    for (const entry of MEMORY_RELEVANCE_SCENARIOS) expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
  });

  it('put at most five in the live subset: m08, m09, m10, m12 and m13', () => {
    expect(MEMORY_RELEVANCE_SCENARIOS.filter((entry) => entry.live_subset).map((entry) => entry.id.slice(0, 3))).toEqual(['m08', 'm09', 'm10', 'm12', 'm13']);
  });

  it('seed sixty owner facts, the relevant one the oldest, none pinned, and more text than the recent block holds', () => {
    for (const id of ['m07', 'm08', 'm09']) {
      const memory = scenario(id).world.memory!;
      expect(memory).toHaveLength(60);
      expect(Math.min(...memory.map((claim) => claim.id))).toBe(memory[0]!.id);
      expect(memory.some((claim) => claim.pinned)).toBe(false);
      expect(memory.slice(1).reduce((sum, claim) => sum + claim.text.length, 0)).toBeGreaterThan(PROFILE_BLOCK_MAX_CHARS + FACTS_BLOCK_MAX_CHARS);
    }
  });

  it('keep m08 and m09 free of the question\'s words, and m07 not', () => {
    const terms = (id: string) => ftsTerms(scenario(id).steps.flatMap((step) => ('say' in step ? [step.say] : [])).join(' '));
    const fact = (id: string) => ftsTerms(scenario(id).world.memory![0]!.text);
    expect(terms('m08').filter((term) => fact('m08').includes(term))).toEqual([]);
    expect(terms('m09').filter((term) => fact('m09').includes(term))).toEqual([]);
    expect(terms('m07').filter((term) => fact('m07').includes(term)).length).toBeGreaterThan(0);
  });

  it('never name, in a question, the words the forgotten, held or health claims carry', () => {
    const asked = (id: string) => scenario(id).steps.flatMap((step) => ('say' in step ? [step.say] : 'outside_job' in step ? [step.outside_job] : [])).join(' ').toLowerCase();
    expect(asked('m12')).not.toMatch(/okafor|lotus/);
    expect(asked('m13')).not.toMatch(/sleep|badly/);
  });
});

describe('the shown-ids receipt', () => {
  const tagged = (id: number) => `- [c${id} · provisional] The owner's dentist, Dr. Rao, sees them on Tuesdays.`;
  it('holds when the claim\'s tag is in a request of that turn, and not for another turn', () => {
    const receipt = reaches(2001, 'park road clinic', 1, 'shown');
    expect(receipt.holds(evidence([{ turn: 1, text: tagged(2001) }]))).toBe(true);
    expect(receipt.holds(evidence([{ turn: 2, text: tagged(2001) }]))).toBe(false);
    expect(receipt.holds(evidence([{ turn: 1, text: tagged(2002) }]))).toBe(false);
  });

  it('also holds when the model read the claim with read_memory, and not for another tool\'s output', () => {
    const receipt = reaches(2001, 'park road clinic', 1, 'shown');
    expect(receipt.holds(evidence([{ turn: 1, text: 'nothing' }], { toolOutputs: [{ name: 'read_memory', output: '{"claims":[{"text":"... the Park Road clinic ..."}]}' }] }))).toBe(true);
    expect(receipt.holds(evidence([{ turn: 1, text: 'nothing' }], { toolOutputs: [{ name: 'search_episodes', output: 'Park Road clinic' }] }))).toBe(false);
  });

  it('reads the tags of the claim written this trial, by its words', () => {
    const receipt = reachesWritten('thursday', 2, 'written then shown');
    const memory = [{ id: 5, text: 'Grocery shopping is on Thursdays.', status: 'active', seeded: false }, { id: 2002, text: 'Thursday seeded.', status: 'active', seeded: true }];
    expect(receipt.holds(evidence([{ turn: 2, text: tagged(5) }], { final_state: { memory } }))).toBe(true);
    expect(receipt.holds(evidence([{ turn: 2, text: tagged(2002) }], { final_state: { memory } }))).toBe(false);
    expect(receipt.holds(evidence([{ turn: 1, text: tagged(5) }], { final_state: { memory } }))).toBe(false);
    expect(receipt.holds(evidence([{ turn: 2, text: tagged(5) }], { final_state: { memory: [{ ...memory[0]!, status: 'forgotten' }] } }))).toBe(false);
  });

  it('does not count a stub as shown: the claim counts once read_memory opens it', () => {
    const receipt = reaches(2001, 'park road clinic', 1, 'shown');
    const stub = '- [c2001 stub · fact] The owner\'s dentist, Dr. Rao, sees them on Tuesdays at the P…';
    expect(receipt.holds(evidence([{ turn: 1, text: stub }]))).toBe(false);
    expect(receipt.holds(evidence([{ turn: 1, text: stub }], { toolOutputs: [{ name: 'read_memory', output: '{"claims":[{"text":"... the Park Road clinic."}]}' }] }))).toBe(true);
  });

  it('fails m12 and m13 when a forgotten or held claim reaches the model even as a stub', () => {
    expect(neverReaches([{ id: 3002, needle: 'lotus hall' }], 'never').holds(evidence([{ turn: 1, text: '- [c3002 stub · fact] The owner paid the…' }]))).toBe(false);
  });

  it('fails m12 and m13 when a forgotten, held or health claim is shown, read or repeated', () => {
    const receipt = neverReaches([{ id: 3001, needle: 'okafor' }, { id: 3002, needle: 'lotus hall' }], 'never', undefined);
    expect(receipt.holds(evidence([{ turn: 1, text: 'clean input' }]))).toBe(true);
    expect(receipt.holds(evidence([{ turn: 1, text: tagged(3002) }]))).toBe(false);
    expect(receipt.holds(evidence([{ turn: 1, text: 'The Lotus Hall deposit' }]))).toBe(false);
    expect(receipt.holds(evidence([{ turn: 1, text: 'clean' }], { toolOutputs: [{ name: 'read_memory', output: 'Mr. Okafor' }] }))).toBe(false);
    expect(receipt.holds(evidence([{ turn: 1, text: 'clean' }], { transcript: [{ role: 'waldo', text: 'About Okafor...' }] }))).toBe(false);
  });
});

describe('the cases against the production prompt', () => {
  it('seeds a forgotten claim as gone, with a barrier, and a held topic as held', async () => {
    const run = await trial('m12');
    expect(run.status).toBe('ran');
    const memory = (run.final_state as { memory: { id: number }[] }).memory;
    expect(memory.some((claim) => claim.id === 3001)).toBe(false);
    expect(memory.some((claim) => claim.id === 3002)).toBe(true);
    expect(failedReceipts(scenario('m12').receipts!, run)).toEqual([]);
  });

  it('runs m13\'s job as a notification over outside text, a turn of its own, and keeps the health pattern out of it', async () => {
    const run = await trial('m13');
    expect(run.status).toBe('ran');
    expect(run.transcript.map((turn) => turn.role)).toEqual(['world', 'waldo']);
    expect(run.transcript[1]).toMatchObject({ surface: 'notification' });
    expect(run.model_inputs.every((input) => input.turn === 1)).toBe(true);
    expect(failedReceipts(scenario('m13').receipts!, run)).toEqual([]);
  });

  it('shows the claim a model saved on the first turn to the model on the second (m10)', async () => {
    const run = await trial('m10', [
      { match: /Remember that I moved/, rounds: [{ toolCalls: [remember('The owner does their grocery shopping on Thursdays.', 'I moved my grocery shopping to Thursdays.')] }, { text: 'Noted: Thursdays.' }] },
      { match: /Which day is my grocery run/, rounds: [{ text: 'Thursday.' }] },
    ]);
    expect(run.status).toBe('ran');
    expect(failedReceipts(scenario('m10').receipts!, run)).toEqual([]);
  });

  it('fails m10 when the model saved nothing on the first turn', async () => {
    const run = await trial('m10');
    expect(failedReceipts(scenario('m10').receipts!, run)).toEqual(['the claim written on the first turn was shown to the model on the second']);
  });

  it('gives the plan a turn for the outside job', () => {
    expect(callPlan([scenario('m13')], 1).owner_turns).toBe(1);
  });
});

describe('the cases with memory selection on (option B)', () => {
  const opened = (ids: readonly number[]) => ({ name: 'read_memory', arguments: { ids } });
  it('m11: the dentist claim arrives as a stub, and the model that opens it by id passes', async () => {
    const run = await trial('m11', [{ match: /Which day does my dentist/, rounds: [{ toolCalls: [opened([2001])] }, { text: 'Tuesdays, at the Park Road clinic.' }] }], { memorySelection: true });
    expect(run.status).toBe('ran');
    expect(run.model_inputs[0]!.text).toMatch(/c2001 stub · fact/);
    expect(run.model_inputs[0]!.text).not.toMatch(/c2001 · /);
    expect(failedReceipts(scenario('m11').receipts!, run)).toEqual([]);
  });

  it('m11 without selection: the dentist claim is neither shown nor offered', async () => {
    const run = await trial('m11');
    expect(run.model_inputs[0]!.text).not.toMatch(/c2001\b/);
    expect(failedReceipts(scenario('m11').receipts!, run)).not.toEqual([]);
  });

  it('m10: the fact saved on the first turn is new, so it is in the core on the second', async () => {
    const run = await trial('m10', [
      { match: /Remember that I moved/, rounds: [{ toolCalls: [remember('The owner does their grocery shopping on Thursdays.', 'I moved my grocery shopping to Thursdays.')] }, { text: 'Noted: Thursdays.' }] },
      { match: /Which day is my grocery run/, rounds: [{ text: 'Thursday.' }] },
    ], { memorySelection: true });
    expect(failedReceipts(scenario('m10').receipts!, run)).toEqual([]);
    expect(run.model_inputs.filter((input) => input.turn === 2).some((input) => input.text.includes('<owner_new>'))).toBe(true);
  });

  it('reaches every trial of a run that turns it on', async () => {
    const gateway = scriptedGateway({ rules: [], unmatchedText: 'Noted.' });
    const { runNightly } = await import('../evals/nightly/suite');
    await runNightly([scenario('m11')], { trials: 1, budget: callBudget(10), gateway: () => gateway, judge: async () => ({ outcome: 'judge_error' }), candidate: 'x', judgeModel: 'y', memorySelection: true });
    expect(JSON.stringify(gateway.requests()[0]!.request)).toMatch(/c2001 stub · fact/);
  });

  it('m12 and m13: nothing forgotten, held or health is shown, offered or opened', async () => {
    for (const id of ['m12', 'm13']) {
      const run = await trial(id, [], { memorySelection: true });
      expect(run.status, id).toBe('ran');
      expect(failedReceipts(scenario(id).receipts!, run), id).toEqual([]);
    }
    const opening = await trial('m12', [{ match: /deposits/, rounds: [{ toolCalls: [opened([3001, 3002])] }, { text: 'Nothing to share.' }] }], { memorySelection: true });
    expect(failedReceipts(scenario('m12').receipts!, opening)).toEqual([]);
  });
});

describe('m08 with the semantic leg on and off', () => {
  const shownTeeth = (failed: readonly string[]) => !failed.some((receipt) => receipt.includes('teeth-cleaning claim'));
  it('misses the teeth-cleaning claim on words alone, and shows it once the leg is on', async () => {
    const off = await trial('m08');
    const on = await trial('m08', [], { semantic: true });
    expect(shownTeeth(failedReceipts(scenario('m08').receipts!, off))).toBe(false);
    expect(failedReceipts(scenario('m08').receipts!, on)).toEqual([]);
  });
});
