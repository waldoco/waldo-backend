// A card raised in the owner's own turn keeps where the owner asked. Approved anywhere, its replay carries that into the work it
// starts, and the work's report answers in the asking conversation: asked on WhatsApp and approved in the app, the report goes
// to the owner's WhatsApp chat; asked in an app thread, to that thread.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildSessionState, type TaskResult, type ToolName } from '@waldo/contracts';
import { approvalDesk } from '../src/channels/approvals';
import { routedDelivery } from '../src/channels/delivery-routes';
import { askedOnWhatsApp } from '../src/channels/proactive-surface';
import type { FinalRecord } from '../src/channels/telegram-final-outbox';
import { sanitise } from '../src/scribe/sanitiser';
import type { TaskHost } from '../src/tasks/brain';
import { jobBook, taskBrief, type JobBook } from '../src/tasks/jobs';
import { runJobsLane } from '../src/tasks/lane';
import { taskToolHandlers } from '../src/tasks/tools';
import { proposeActionHandler, taintedActionReplay } from '../src/tools/live/propose-action';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

const T0 = 1_800_000_000_000;
const SUBJECT = '15550005555';
const CANARIES = ['a1b2c3d4e5f60718', '1a2b3c4d5e6f7081', 'f0e1d2c3b4a59687'];
const research = { profile: 'reader', title: 'Five new signups', goal: 'Find each signup on the web and in my mail.', context: 'Names from the alert.', done_when: 'A line on each.' };
const result: TaskResult = { status: 'done', summary: 'All five found.', findings: [{ text: 'Asha Rao runs a studio.' }], proposals: [], left: [] };
const turnOn = (askedIn: ToolDispatcherContext['askedIn']): ToolDispatcherContext => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: 'external', ownerInitiated: true,
  sanitise, hasApproval: () => true, turnId: 'turn-1', toolCallId: 'call-1', askedIn,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: T0 }),
});
const replayContext = (): ToolDispatcherContext => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: 'external', sanitise, hasApproval: () => true,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: T0 }),
});

// The owner's card raised in a WhatsApp (or app-thread) turn and decided in the app: the app desk replays it through the real
// dispatcher and task tools over a real job book, and the jobs lane hands the report to delivery.
const approvedInApp = (askedIn: NonNullable<ToolDispatcherContext['askedIn']>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`asked-in-${crypto.randomUUID()}`)), async (_instance, state) => {
    let n = 0;
    const book: JobBook = jobBook(state.storage.sql, { now: () => T0, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    // The app's own desk and tools: the replay runs on the app's runtime, whatever surface the owner asked on.
    const tools = taskToolHandlers({ book, now: () => T0, timezone: () => 'UTC', surface: 'app', wake: async () => undefined, fence: () => undefined, log: () => undefined });
    const desk = approvalDesk(state.storage.sql, {
      owner: 1, surface: 'app', call: async () => ({ message_id: 1 }), google: async () => null, newId: () => `a${++n}`, now: () => T0, timezone: 'UTC', log: () => undefined,
      commit: work => state.storage.transactionSync(work), replayTaintedAction: taintedActionReplay({ handlers: () => tools as never, context: replayContext }),
    });
    const proposed = await proposeActionHandler(desk).handle({ tool: 'start_task', args: research, reasoning: 'The alert lists five signups.' } as never, turnOn(askedIn));
    expect(proposed).toMatchObject({ ok: true, data: { executed: false } });
    expect(book.open()).toEqual([]);
    const id = (proposed as { data: { proposal_id: string } }).data.proposal_id;
    expect((await desk.decide(id, 'a', 'trace', { surface: 'app' })).toast).toBe('Done');
    const [job] = book.open().filter(row => row.kind === 'task');
    // A settled job keeps only its title, so the brief is read while the job is open.
    const brief = taskBrief(job!);
    // The worker reports; the jobs lane applies it and hands the report to delivery with where it was asked.
    const ticket = book.startAttempt(job!.id)!;
    expect(book.report(ticket, result, { rounds: 1, costUsd: 0 })).toBe('accepted');
    const delivered: Array<{ id: string; conversationRef?: string; askedIn?: unknown }> = [];
    await runJobsLane({
      book, host: { fence: () => undefined, cancelled: () => undefined, endAsk: () => undefined, busy: () => new Set() } as unknown as TaskHost,
      now: () => T0, timezone: 'UTC', surface: 'app', quiet: () => false, log: () => undefined, startWorker: async () => undefined,
      turn: async () => 'All five found: Asha Rao runs a studio.', applyTools: () => ['search_communication'] as ToolName[],
      deliver: async (key, _trace, _text, commit, conversationRef, asked) => { state.storage.transactionSync(commit); delivered.push({ id: key, ...(conversationRef ? { conversationRef } : {}), ...(asked ? { askedIn: asked } : {}) }); },
      room: () => true, heldTopics: () => [], startReplay: () => undefined, approvals: { replays: () => [], replayReceipt: () => '', settleReplay: () => false },
    });
    return { job: book.get(job!.id)!, brief, delivered };
  });

describe('a card raised in the owner\'s turn and approved in the app', () => {
  it('asked on WhatsApp: the job keeps the WhatsApp chat, and its report is handed to delivery for that chat', async () => {
    const asked = { surface: 'whatsapp', conversation_ref: `whatsapp-${SUBJECT}` };
    const { job, brief, delivered } = await approvedInApp(asked);
    expect(brief).toMatchObject({ asked_in: asked, owner_approved: true, outside_text: true });
    expect(brief.conversation_ref).toBeUndefined();
    expect(job.status).toBe('applied');
    expect(delivered).toEqual([{ id: `task:${job.id}`, askedIn: asked }]);
  });

  it('asked in an app thread: the report goes to that thread', async () => {
    const asked = { surface: 'app', conversation_ref: 'owner:prn_1:thr_3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607' };
    const { job, brief, delivered } = await approvedInApp(asked);
    expect(brief).toMatchObject({ asked_in: asked, conversation_ref: asked.conversation_ref });
    expect(delivered).toEqual([{ id: `task:${job.id}`, conversationRef: asked.conversation_ref, askedIn: asked }]);
  });
});

describe('a report addressed to the WhatsApp chat it was asked in', () => {
  const record = (over: Partial<FinalRecord>): FinalRecord => ({ id: 'task:job_1', trace: 't', payload: { chat_id: Number(SUBJECT), text: 'All five found.' }, digest: 'd', ownerSubject: SUBJECT, doName: 'owner',
    status: 'pending', dueAt: T0, createdAt: T0, attempts: 0, ...over } as FinalRecord);
  const route = (name: string, addressed: (r: FinalRecord) => boolean, sent: string[]) => ({
    addressed, allowed: async () => true, defer: async () => null, send: async () => { sent.push(name); return { message_id: 1 }; },
  });

  it('goes to WhatsApp ahead of the proactive surface, and nothing else is pulled there', async () => {
    const sent: string[] = [];
    // The proactive route takes everything addressed to the app owner; the answer route only answers asked on WhatsApp.
    const delivery = routedDelivery([route('whatsapp', askedOnWhatsApp(SUBJECT), sent) as never, route('app', r => r.payload.chat_id === 7, sent) as never]);
    await delivery.send({ chat_id: Number(SUBJECT), text: 'x' }, record({ askedOn: 'whatsapp' }));
    await delivery.send({ chat_id: 7, text: 'x' }, record({ payload: { chat_id: 7, text: 'x' }, ownerSubject: '7' }));
    expect(sent).toEqual(['whatsapp', 'app']);
    expect(askedOnWhatsApp(SUBJECT)(record({}))).toBe(false);
    expect(askedOnWhatsApp(SUBJECT)(record({ askedOn: 'whatsapp', ownerSubject: '15550009999', payload: { chat_id: 15550009999, text: 'x' } }))).toBe(false);
  });
});
