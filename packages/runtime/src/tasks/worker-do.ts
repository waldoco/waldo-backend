import { DurableObject } from 'cloudflare:workers';
import type { LLMToolCall, LLMToolTurn } from '@waldo/contracts';
import type { TelegramWebhookEnv } from '../channels/telegram-webhook';
import type { TurnLogEntry } from '../channels/owner-turn-types';
import type { LoopToolResult } from '../conversation/tool-loop';
import { armAlarm } from '../scheduler/alarm-slot';
import type { TaskTicket } from './jobs';
import { runTaskAttempt, taskModel, type TaskBrainPort, type TaskClaim, type TaskOutcome, type TaskSpend } from './worker-loop';

// A task worker: one object per job attempt, holding nothing but the ticket it was started with. It runs the attempt from
// its own alarm and calls the owner's object for everything else. Its alarm never throws, so the platform's alarm retry
// never becomes a second retry owner: an attempt that cannot go on just stops, its lease lapses, and the brain decides.

// What the worker may call on the owner's object.
export type OwnerTaskRpc = Readonly<{
  taskClaim(ticket: TaskTicket): Promise<TaskClaim | 'fenced'>;
  taskTool(ticket: TaskTicket, call: LLMToolCall, canaries: readonly string[]): Promise<LoopToolResult | 'fenced'>;
  taskCheckpoint(ticket: TaskTicket, seq: number, turns: readonly LLMToolTurn[], events: readonly TurnLogEntry[], spend: TaskSpend): Promise<'ok' | 'stale' | 'fenced'>;
  taskReport(ticket: TaskTicket, outcome: TaskOutcome, events: readonly TurnLogEntry[], spend: TaskSpend): Promise<'accepted' | 'duplicate' | 'fenced' | 'deferred' | 'parked'>;
}>;
type Held = Readonly<{ owner: string; ticket: TaskTicket }>;

const HELD_KEY = 'task_worker_ticket_v1';
// An alarm invocation may run for 15 minutes; the attempt hands over to a fresh alarm well before that, after a checkpoint.
export const TASK_ALARM_SLICE_MS = 10 * 60_000;

export const taskWorkerName = (ownerDoId: string, ticket: TaskTicket): string => `job:${ownerDoId}:${ticket.jobId}:${ticket.attempt}`;

export class TaskWorkerDO extends DurableObject<TelegramWebhookEnv> {
  // Idempotent: a second start of the same attempt changes nothing; the alarm runs it once.
  async start(input: Held): Promise<void> {
    if (!this.ctx.storage.kv.get<Held>(HELD_KEY)) this.ctx.storage.kv.put(HELD_KEY, input);
    await armAlarm(this.ctx.storage, Date.now());
  }

  async stop(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    const held = this.ctx.storage.kv.get<Held>(HELD_KEY);
    if (!held || !this.env.OWNER_DO) return;
    let outcome: Awaited<ReturnType<typeof runTaskAttempt>> = 'lost';
    try {
      const owner = this.env.OWNER_DO.get(this.env.OWNER_DO.idFromString(held.owner)) as unknown as OwnerTaskRpc;
      const brain: TaskBrainPort = {
        claim: (ticket) => owner.taskClaim(ticket),
        tool: (ticket, call, canaries) => owner.taskTool(ticket, call, canaries),
        checkpoint: (ticket, seq, turns, events, spend) => owner.taskCheckpoint(ticket, seq, turns, events, spend),
        report: (ticket, result, events, spend) => owner.taskReport(ticket, result, events, spend),
      };
      const access = { openaiApiKey: this.env.OPENAI_API_KEY ?? '', ...(this.env.ANTHROPIC_API_KEY === undefined ? {} : { anthropicApiKey: this.env.ANTHROPIC_API_KEY }) };
      outcome = await runTaskAttempt(held.ticket, { brain, model: taskModel(access), sliceEnd: Date.now() + TASK_ALARM_SLICE_MS });
    } catch {
      outcome = 'lost';
    }
    console.log(JSON.stringify({ hop: 'task_worker_alarm', ok: outcome !== 'lost', code: outcome, job_id: held.ticket.jobId }));
    if (outcome === 'continue') { await armAlarm(this.ctx.storage, Date.now()); return; }
    await this.ctx.storage.deleteAll();
  }
}
