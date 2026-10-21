import { describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_PROVIDER, OPENAI_GPT_6_LUNA_MODEL, OPENAI_PROVIDER, type LLMToolCall, type LLMToolTurn, type TaskResult } from '@waldo/contracts';
import type { LoopToolResult } from '../src/conversation/tool-loop';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { TaskBrief, TaskTicket } from '../src/tasks/jobs';
import { FINISH_TASK, runTaskAttempt, TASK_HEARTBEAT_MS, taskModel, TaskProviderUnavailable, type TaskBrainPort, type TaskClaim, type TaskModel, type TaskOutcome } from '../src/tasks/worker-loop';
import { faultInjectedProviders } from './helpers/fault-injection';

// One worker attempt against a fake brain and a scripted model. The brain side is a plain recorder here; the job book's
// own fencing is covered in task-jobs.test.ts and the RPC seam in the owner tests.
const brief: TaskBrief = { title: 'Inbox since Monday', goal: 'Find unanswered client mail.', context: 'Clients write from company domains.', done_when: 'A list of threads.', effort: 'standard', timezone: 'Europe/London', started_at: 1_800_000_000_000 };
const ticket: TaskTicket = { jobId: 'job_000000000001', attempt: 1, token: 'tok' };
const result: TaskResult = { status: 'done', summary: 'Two threads wait on you.', findings: [{ text: 'Asha asked for the quote.', source_ref: 'gmail:t1' }], proposals: [], left: [] };
const search = { name: 'search_communication', description: 'Search mail.', parameters: { type: 'object', properties: {} } };

type Script = Array<{ call: string; args?: unknown } | { text: string } | 'unavailable' | 'hang'>;
const fakeBrain = (initial: Partial<TaskClaim> = {}, fenceTools = false, held: () => boolean = () => true) => {
  const log = { beats: 0, tools: [] as LLMToolCall[], checkpoints: [] as Array<{ seq: number; turns: readonly LLMToolTurn[]; events: readonly TurnLogEntry[] }>, reports: [] as TaskOutcome[], events: [] as TurnLogEntry[] };
  let saved: readonly LLMToolTurn[] = initial.turns ?? [];
  let seq = initial.seq ?? 0;
  const brain: TaskBrainPort = {
    claim: async () => ({ jobId: ticket.jobId, profile: 'reader', brief, tools: [search], mutations: [], deadlineAt: Date.now() + 3_600_000, roundsUsed: 0, ownerRef: 'owner-1', ...initial, ...{ turns: saved, seq } }),
    tool: async (_ticket, call) => {
      if (fenceTools) return 'fenced';
      log.tools.push(call);
      return { ok: true, data: { hits: [`hit for ${call.arguments}`] }, source_taint: 'external' } satisfies LoopToolResult;
    },
    checkpoint: async (_ticket, next, turns, events) => { log.checkpoints.push({ seq: next, turns, events }); log.events.push(...events); if (next > seq) { seq = next; saved = turns; } return 'ok'; },
    report: async (_ticket, outcome, events) => { log.reports.push(outcome); log.events.push(...events); return 'accepted'; },
    heartbeat: async () => { log.beats += 1; return held(); },
  };
  return { brain, log };
};
const scripted = (script: Script, seen: Array<{ turns: readonly LLMToolTurn[]; content: string; tools: readonly string[] }> = []): TaskModel => {
  let n = 0;
  return async ({ content, tools, turns }) => {
    const next = script[Math.min(n, script.length - 1)]!;
    n += 1;
    seen.push({ turns: [...turns], content, tools: (tools ?? []).map(tool => tool.name) });
    const event: TurnLogEntry = { trace: 'task:x', hop: 'llm_task', ms: 1, ok: true, job_id: ticket.jobId, job_profile: 'reader', cost_kind: 'worker', usage: { model: OPENAI_GPT_6_LUNA_MODEL, input: 10, output: 2, cached: 0 } };
    if (next === 'unavailable') throw new TaskProviderUnavailable({ ...event, ok: false, usage: undefined });
    if (next === 'hang') return new Promise(() => undefined);
    if ('text' in next) return { response: { text: next.text }, event };
    return { response: { text: '', tool_calls: [{ call_id: `c${n}`, name: next.call, arguments: JSON.stringify(next.args ?? {}) }] }, event };
  };
};

describe('a task worker attempt', () => {
  it('reads through the brain, checkpoints each round, and reports its structured result once', async () => {
    const { brain, log } = fakeBrain();
    const seen: Parameters<typeof scripted>[1] = [];
    const outcome = await runTaskAttempt(ticket, { brain, model: scripted([{ call: 'search_communication', args: { query: 'from:client' } }, { call: FINISH_TASK, args: result }], seen), sliceEnd: Date.now() + 60_000 });
    expect(outcome).toBe('reported');
    expect(log.tools.map(call => call.name)).toEqual(['search_communication']);
    expect(log.checkpoints.map(point => point.seq)).toEqual([1]);
    expect(log.reports).toEqual([{ kind: 'result', result }]);
    // The worker sees the brief and the profile's tools only, never the conversation.
    expect(seen[0]!.content).toContain('Goal:\nFind unanswered client mail.');
    expect(seen[0]!.tools).toEqual(['search_communication', FINISH_TASK]);
    // Every model call reaches the brain's log as worker spend, exactly once.
    expect(log.events.filter(event => event.hop === 'llm_task')).toHaveLength(2);
    expect(log.events.every(event => event.cost_kind === 'worker' && event.job_id === ticket.jobId)).toBe(true);
  });

  it('a worker crash mid-job: the next attempt resumes from the checkpoint and never re-runs a finished read', async () => {
    const { brain, log } = fakeBrain();
    // The first attempt checkpoints its read, then dies while waiting on the model (never reports).
    void runTaskAttempt(ticket, { brain, model: scripted([{ call: 'search_communication', args: { query: 'q1' } }, 'hang']), sliceEnd: Date.now() + 60_000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(log.checkpoints).toHaveLength(1);
    expect(log.reports).toEqual([]);
    const seen: Parameters<typeof scripted>[1] = [];
    const resumed = await runTaskAttempt({ ...ticket, attempt: 2, token: 'tok-2' }, { brain, model: scripted([{ call: FINISH_TASK, args: result }], seen), sliceEnd: Date.now() + 60_000 });
    expect(resumed).toBe('reported');
    expect(log.tools.map(call => call.arguments)).toEqual(['{"query":"q1"}']);
    expect(seen[0]!.turns.map(turn => turn.call.name)).toEqual(['search_communication']);
    expect(seen[0]!.content).toContain('interrupted and resumed');
    expect(log.reports).toEqual([{ kind: 'result', result }]);
  });

  it('a model call longer than the lease: heartbeats keep the lease, and a heartbeat the brain refuses stops the attempt', async () => {
    vi.useFakeTimers();
    try {
      const slow = (model: TaskModel): TaskModel => async (input) => { await new Promise(resolve => setTimeout(resolve, TASK_HEARTBEAT_MS * 4)); return model(input); };
      const kept = fakeBrain();
      const reported = runTaskAttempt(ticket, { brain: kept.brain, model: slow(scripted([{ call: FINISH_TASK, args: result }])), sliceEnd: Date.now() + 3_600_000 });
      await vi.advanceTimersByTimeAsync(TASK_HEARTBEAT_MS * 4);
      expect(await reported).toBe('reported');
      expect(kept.log.beats).toBe(4);

      let beats = 0;
      const lost = fakeBrain({}, false, () => (beats += 1) < 2);
      const fenced = runTaskAttempt(ticket, { brain: lost.brain, model: slow(scripted([{ call: FINISH_TASK, args: result }])), sliceEnd: Date.now() + 3_600_000 });
      await vi.advanceTimersByTimeAsync(TASK_HEARTBEAT_MS * 4);
      expect(await fenced).toBe('fenced');
      expect(lost.log.reports).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('stops without reporting when the brain fences it (cancelled, or a newer attempt holds the job)', async () => {
    const { brain, log } = fakeBrain({}, true);
    expect(await runTaskAttempt(ticket, { brain, model: scripted([{ call: 'search_communication' }, { call: FINISH_TASK, args: result }]), sliceEnd: Date.now() + 60_000 })).toBe('fenced');
    expect(log.reports).toEqual([]);
    const fencedClaim = { ...fakeBrain().brain, claim: async () => 'fenced' as const };
    expect(await runTaskAttempt(ticket, { brain: fencedClaim, model: scripted([{ text: 'never' }]), sliceEnd: Date.now() + 60_000 })).toBe('fenced');
  });

  it('the provider down: the attempt reports unavailability, not a result or a crash', async () => {
    const { brain, log } = fakeBrain();
    expect(await runTaskAttempt(ticket, { brain, model: scripted(['unavailable']), sliceEnd: Date.now() + 60_000 })).toBe('reported');
    expect(log.reports).toEqual([{ kind: 'unavailable' }]);
    expect(log.events.at(-1)).toMatchObject({ hop: 'llm_task', ok: false });
  });

  it('ends its alarm slice after a checkpoint and continues later under the same attempt', async () => {
    const { brain, log } = fakeBrain();
    expect(await runTaskAttempt(ticket, { brain, model: scripted([{ call: 'search_communication', args: { query: 'q1' } }, { call: FINISH_TASK, args: result }]), sliceEnd: Date.now() - 1 })).toBe('continue');
    expect(log.checkpoints).toHaveLength(1);
    expect(log.reports).toEqual([]);
    expect(await runTaskAttempt(ticket, { brain, model: scripted([{ call: FINISH_TASK, args: result }]), sliceEnd: Date.now() + 60_000 })).toBe('reported');
    expect(log.tools).toHaveLength(1);
  });

  it('a malformed result goes back to the model to fix; a plain reply still reports as a result', async () => {
    const { brain, log } = fakeBrain();
    await runTaskAttempt(ticket, { brain, model: scripted([{ call: FINISH_TASK, args: { status: 'done' } }, { call: FINISH_TASK, args: result }]), sliceEnd: Date.now() + 60_000 });
    expect(log.reports).toEqual([{ kind: 'result', result }]);
    const plain = fakeBrain();
    await runTaskAttempt(ticket, { brain: plain.brain, model: scripted([{ text: 'Nothing waits on you.' }]), sliceEnd: Date.now() + 60_000 });
    expect(plain.log.reports).toEqual([{ kind: 'result', result: { status: 'done', summary: 'Nothing waits on you.', findings: [], proposals: [], left: [] } }]);
  });
});

describe('the production task model step', () => {
  const claim: TaskClaim = { jobId: ticket.jobId, profile: 'reader', brief, tools: [search], mutations: [], turns: [], seq: 0, deadlineAt: Date.now() + 60_000, roundsUsed: 0, ownerRef: 'owner-1' };
  const input = { ticket, claim, system: 'system', content: 'brief', tools: undefined, turns: [], canaries: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'] };

  it('runs a standard task on the auxiliary model and logs it as worker spend under the job', async () => {
    const { gateway, models } = faultInjectedProviders({ [OPENAI_PROVIDER]: [{ text: 'Read it.' }] });
    const { response, event } = await taskModel({ openaiApiKey: 'fixture-openai' }, gateway)(input);
    expect(response.text).toBe('Read it.');
    expect(models()).toEqual([OPENAI_GPT_6_LUNA_MODEL]);
    expect(event).toMatchObject({ hop: 'llm_task', ok: true, cost_kind: 'worker', job_id: ticket.jobId, job_profile: 'reader', provider: OPENAI_PROVIDER, usage: { model: OPENAI_GPT_6_LUNA_MODEL } });
  });

  it('every provider failing is unavailability, typed, with no usage', async () => {
    const { gateway } = faultInjectedProviders({ [OPENAI_PROVIDER]: [{ fault: 'server_error', status: 503 }], [ANTHROPIC_PROVIDER]: [{ fault: 'server_error', status: 503 }] });
    const failure = await taskModel({ openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic' }, gateway)(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TaskProviderUnavailable);
    expect((failure as TaskProviderUnavailable).event).toMatchObject({ ok: false, cost_kind: 'worker' });
    expect((failure as TaskProviderUnavailable).event).not.toHaveProperty('usage');
  });
});
