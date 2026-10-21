// How far the voice judge agrees with the labelled replies: `pnpm --filter @waldo/runtime eval:voice-agreement`.
// The default is a dry run that checks the labels and says what a live run would spend, with no network. Two other modes:
//   WALDO_VOICE_VERDICTS=<file>  scores verdicts saved by an earlier live run, with no model call;
//   WALDO_EVAL_MODE=live         asks the judge model about every label, one call each, under WALDO_EVAL_MAX_CALLS,
//                                with ANTHROPIC_API_KEY and WALDO_EVAL_JUDGE_MODEL; WALDO_EVAL_OUT saves the verdicts.
// A live run spends money: it runs only when the owner has approved the spend and set the key.
import { readFileSync, writeFileSync } from 'node:fs';
import { callBudget } from './budget';
import { labelInput, labelledVerdict, loadVoiceLabels, voiceAgreement, type LabelledVerdict } from './voice-labels';
import { liveVoiceJudge, voicePacket } from './voice';

const env = process.env;
const labels = loadVoiceLabels();
const required = (name: string) => { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required for a live run`); return value; };

let verdicts: readonly LabelledVerdict[] | null = null;
let judgeModel = 'none';
if (env.WALDO_VOICE_VERDICTS) {
  const saved = JSON.parse(readFileSync(env.WALDO_VOICE_VERDICTS, 'utf8')) as { judge_model: string; verdicts: LabelledVerdict[] };
  verdicts = saved.verdicts;
  judgeModel = saved.judge_model;
} else if (env.WALDO_EVAL_MODE === 'live') {
  judgeModel = required('WALDO_EVAL_JUDGE_MODEL');
  const limit = Number(required('WALDO_EVAL_MAX_CALLS'));
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('WALDO_EVAL_MAX_CALLS must be a positive integer');
  const budget = callBudget(limit);
  const judge = liveVoiceJudge({ apiKey: required('ANTHROPIC_API_KEY'), model: judgeModel, budget });
  const collected: LabelledVerdict[] = [];
  for (const label of labels) collected.push(labelledVerdict(label.id, await judge(labelInput(label))));
  verdicts = collected;
  if (env.WALDO_EVAL_OUT) writeFileSync(env.WALDO_EVAL_OUT, `${JSON.stringify({ judge_model: judgeModel, usage: budget.usage(), verdicts }, null, 2)}\n`);
} else if (env.WALDO_EVAL_MODE !== undefined && env.WALDO_EVAL_MODE !== 'recorded') {
  throw new Error('WALDO_EVAL_MODE must be recorded or live');
}

if (verdicts === null) {
  const packets = labels.map((label) => voicePacket(labelInput(label)).length);
  console.log(JSON.stringify({
    mode: 'dry run: no judge was asked',
    labels: labels.length,
    labelled_pass: labels.filter((label) => label.label === 'pass').length,
    labelled_fail: labels.filter((label) => label.label === 'fail').length,
    reviewed: labels.filter((label) => label.reviewed_by !== null).length,
    live_run_calls: labels.length,
    largest_packet_chars: Math.max(...packets),
  }, null, 2));
} else {
  console.log(JSON.stringify({ judge_model: judgeModel, ...voiceAgreement(labels, verdicts) }, null, 2));
}
