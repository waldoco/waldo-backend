import { expect, it } from 'vitest';
import { literalTextRedactor, redactConversationEntry } from '@waldo/contracts';
import { jobOutcomeRowsEnabled, jobPromptKey, jobPromptStub } from '../src/conversation/job-outcome';

it('the switch is on only for exactly "1"', () => {
  expect(jobOutcomeRowsEnabled({ WALDO_JOB_OUTCOME_ROWS: '1' })).toBe(true);
  for (const value of [undefined, '', '0', 'true', ' 1', 'on']) expect(jobOutcomeRowsEnabled({ WALDO_JOB_OUTCOME_ROWS: value })).toBe(false);
});

it('a stub keeps the row\'s links and drops its text from both views; equal prompts share a key, different ones do not', async () => {
  const row = { id: 'card:brief:1', ownerId: 'o', chatId: 'c', parentId: 'p', threadAnchorId: null, surface: 'agent', modelPayload: 'the whole job prompt', appPayload: 'the whole job prompt',
    modelProjection: { mode: 'include' as const }, role: 'user' as const, inputOrigin: 'machine' as const, createdAt: 1 };
  const key = await jobPromptKey(row.modelPayload);
  expect(jobPromptStub(row, key)).toEqual({ ...row, modelPayload: key, appPayload: '', modelProjection: { mode: 'omit' } });
  expect(await jobPromptKey('the whole job prompt')).toBe(key);
  expect(await jobPromptKey('the whole job prompt.')).not.toBe(key);
  expect(JSON.stringify(jobPromptStub(row, key))).not.toContain('the whole job prompt');
});

it('a forget of the owner\'s words leaves a stub\'s key intact, so a retried job still replays', async () => {
  const row = { id: 'card:brief:1', ownerId: 'o', chatId: 'c', parentId: 'p', threadAnchorId: null, surface: 'agent', modelPayload: '', appPayload: '',
    modelProjection: { mode: 'include' as const }, role: 'user' as const, inputOrigin: 'machine' as const };
  const stub = jobPromptStub(row, await jobPromptKey('Write the Brief about my job and the prompt deadline.'));
  const forget = literalTextRedactor(['job', 'prompt', 'brief', 'card'], '[forgotten]');
  expect(redactConversationEntry(stub, forget)).toEqual(stub);
});
