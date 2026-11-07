import { expect, it } from 'vitest';
import { literalTextRedactor, redactConversationEntry } from '@waldo/contracts';
import { sha256Hex } from '../src/context-composer/canonical';
import { jobOutcomeRowsEnabled, jobPromptKey, jobPromptStub, sameJobPrompt } from '../src/conversation/job-outcome';

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

it('no forget, of a word or a number, can rewrite a stub\'s key, so a retried job still replays', async () => {
  const row = { id: 'card:brief:1', ownerId: 'o', chatId: 'c', parentId: 'p', threadAnchorId: null, surface: 'agent', modelPayload: '', appPayload: '',
    modelProjection: { mode: 'include' as const }, role: 'user' as const, inputOrigin: 'machine' as const };
  const forget = literalTextRedactor(['job', 'prompt', 'brief', 'card', '7', '42', 'dad', 'face', '3d', 'a', 'p'], '[forgotten]');
  for (let n = 0; n < 200; n++) {
    const stub = jobPromptStub(row, await jobPromptKey(`Write the Brief about my job, number ${n}.`));
    expect(redactConversationEntry(stub, forget)).toEqual(stub);
  }
});

it('a retried job is the same job when its stored request is the prompt itself, its key, or a key in the earlier hex form', async () => {
  const said = 'Write the Brief for Saturday.';
  for (const stored of [said, await jobPromptKey(said), `#${await sha256Hex(said)}`]) expect(await sameJobPrompt(stored, said)).toBe(true);
  expect(await sameJobPrompt('# Weekly review', '# Weekly review')).toBe(true);
  for (const stored of [undefined, '', 'Write the Brief for Sunday.', await jobPromptKey('Write the Brief for Sunday.'), `#${await sha256Hex('Write the Brief for Sunday.')}`])
    expect(await sameJobPrompt(stored, said)).toBe(false);
});
