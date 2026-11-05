import { expect, it } from 'vitest';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { FILE_SCENARIOS } from '../evals/nightly/file-scenarios';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';
import { scriptedGateway } from '../src/testing/scripted-gateway';

// The files set's deterministic half, on recorded model rounds: the upload is kept through the production keeper, the
// turn's note names it, and the production workspace tools unpack and read it. Whether a live model picks the tools by
// itself is the live run's measure.
const scenario = (id: string) => FILE_SCENARIOS.find((entry) => entry.id === id)!;
// The world counts ids from 1: the upload is file ...0001 (blob ...0002); the archive's entries follow in its order.
const UPLOAD = 'f17e0000-f17e-4f17-8f17-000000000001';
const AGENDA = 'f17e0000-f17e-4f17-8f17-000000000003';

it('registers the files set in the full catalogue, outside the capped live subset', () => {
  expect(FILE_SCENARIOS.map((entry) => entry.id)).toEqual(['f1-whats-in-this-zip', 'f2-next-meeting-no-files']);
  for (const entry of FILE_SCENARIOS) { expect(NIGHTLY_SCENARIOS).toContain(entry); expect(entry.live_subset).toBeUndefined(); }
});

it("what's in this zip: kept, noted, unpacked and read through the production tools", async () => {
  const model = scriptedGateway({ rules: [{ match: /in this zip/, rounds: [
    { toolCalls: [{ name: 'extract_archive', arguments: { file_id: UPLOAD, revision: 1 } }] },
    { toolCalls: [{ name: 'workspace_read', arguments: { file_id: AGENDA, revision: 1 } }] },
    { text: 'It holds the offsite agenda (roadmap review at 10:00, hiring plan at 14:00, dinner at Olive at 16:30) and a budget sheet.' },
  ] }] });
  const record = await runTrial(scenario('f1-whats-in-this-zip'), { gateway: model, budget: callBudget(40), model: WALDO_CHAT_MODEL });
  expect(record.status).toBe('ran');
  const said = JSON.stringify(model.requests().find((request) => request.request.tools?.length)?.request.messages);
  expect(said).toContain(`offsite.zip (file_id ${UPLOAD}, revision 1). It is not attached here; open it with the workspace tools.`);
  expect(record.tools.map((tool) => [tool.name, tool.ok])).toEqual([['extract_archive', true], ['workspace_read', true]]);
  expect((record.final_state as { workspace: { path: string }[] }).workspace.map((file) => file.path)).toEqual(expect.arrayContaining([expect.stringMatching(/^uploads\/[0-9a-f]{8}\/offsite\/agenda\.md$/)]));
  expect(failedReceipts([...STATE_INVARIANTS, ...scenario('f1-whats-in-this-zip').receipts!], record)).toEqual([]);
});

it('the next-meeting control passes using no file tool, and a file tool call fails its receipt', async () => {
  const plain = scriptedGateway({ rules: [{ match: /next meeting/, rounds: [{ toolCalls: [{ name: 'query_calendar', arguments: {} }] }, { text: 'Standup at 10:00.' }] }] });
  const record = await runTrial(scenario('f2-next-meeting-no-files'), { gateway: plain, budget: callBudget(40), model: WALDO_CHAT_MODEL });
  expect(failedReceipts([...STATE_INVARIANTS, ...scenario('f2-next-meeting-no-files').receipts!], record)).toEqual([]);
  const wandered = scriptedGateway({ rules: [{ match: /next meeting/, rounds: [{ toolCalls: [{ name: 'workspace_list', arguments: {} }] }, { text: 'Standup at 10:00.' }] }] });
  const off = await runTrial(scenario('f2-next-meeting-no-files'), { gateway: wandered, budget: callBudget(40), model: WALDO_CHAT_MODEL });
  expect(failedReceipts(scenario('f2-next-meeting-no-files').receipts!, off)).toEqual(['no file tool was called for a question no file answers']);
});
