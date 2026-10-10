import { googleTaskProposalSchema, googleTaskResourceSchema, proposeGoogleTaskChangeArgsSchema, type GoogleTaskProposal, type GoogleTaskResource, type ProposeGoogleTaskChangeArgs } from '@waldo/contracts';
import { GoogleError, sha256Hex, type GoogleClient, type GoogleTaskPatch } from '../connectors/google';
import { EffectUnknownError, type EffectReceipt, type EffectReadback, type OwnerEffectLedger } from './owner-effect-ledger';
import { taskSourceClient } from '../tools/task-source-io';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import type { GoogleAccess } from '../tools/live/google';

export type { GoogleTaskProposal } from '@waldo/contracts';
export class GoogleTaskConnectorUnavailableError extends Error {
  constructor() { super('The selected Google task account is not connected'); }
}
export type GoogleTaskApplyOutcome = Readonly<{ status: 'done' | 'stale' | 'not_applied' | 'unknown'; receipt?: EffectReceipt }>;
export type GoogleTaskSourceGuard = Pick<ToolDispatcherContext, 'assertTaskSourceCurrent'>;
type Ack = { identity: string; task_json: string };
type TaskResult = { status: 'applied' | 'stale' | 'not_applied'; readback_verified: boolean; account: GoogleTaskProposal['account']; task: GoogleTaskResource | null };

const sameAccount = (client: GoogleClient, account: GoogleTaskProposal['account']) => client.account?.connection_id === account.connection_id && client.account?.email?.toLowerCase() === account.email.toLowerCase();
const patchFor = (p: GoogleTaskProposal): GoogleTaskPatch => ({ ...p.args.changes, ...(p.args.action === 'complete' ? { status: 'done' as const } : p.args.action === 'reopen' || p.args.action === 'create' ? { status: 'todo' as const } : {}) });
const finalFields = (p: GoogleTaskProposal) => {
  const patch = patchFor(p);
  return { title: patch.title ?? p.before?.title ?? '', status: patch.status ?? p.before?.status ?? 'todo', notes: patch.notes === undefined ? p.before?.notes ?? null : patch.notes || null, due_date: patch.due_date === undefined ? p.before?.due_date ?? null : patch.due_date, parent: p.before?.parent ?? null, assigned: false, deleted: false };
};
const matchesFinal = (p: GoogleTaskProposal, current: GoogleTaskResource) => {
  const fields = finalFields(p);
  return current.task_list_id === p.args.task_list_id && (p.args.action === 'create' || current.id === p.args.task_id)
    && (Object.keys(fields) as (keyof typeof fields)[]).every(key => fields[key] === current[key]);
};
export const describeGoogleTaskChange = (p: GoogleTaskProposal): string => {
  const f = finalFields(p);
  return `${p.args.action} Google task “${f.title}” in ${p.list.title} (${p.account.email}).${p.args.changes?.due_date !== undefined ? ` Due date: ${f.due_date ?? 'none'}.` : ''} ${p.args.reason}`;
};

// The owner approves exactly what this shows: only fields that change, before → after,
// built from the frozen proposal rather than re-read from the provider.
export const reviewGoogleTaskChange = (p: GoogleTaskProposal): string => {
  const was = p.before, will = finalFields(p);
  const text = (value: string | null) => value ? `“${value}”` : 'none';
  const state = (value: string) => value === 'done' ? 'Done' : 'To do';
  const line = (label: string, before: string | undefined, after: string) => `- ${label}: ${before === undefined ? '' : `${before} → `}${after}`;
  const creating = !was;
  const changes = [
    ...(creating || was.title !== will.title ? [line('Title', creating ? undefined : text(was.title), text(will.title))] : []),
    ...(creating ? (will.notes ? [line('Notes', undefined, text(will.notes))] : []) : was.notes !== will.notes ? [line('Notes', text(was.notes), text(will.notes))] : []),
    ...(creating ? (will.due_date ? [line('Due', undefined, will.due_date)] : []) : was.due_date !== will.due_date ? [line('Due', was.due_date ?? 'none', will.due_date ?? 'none')] : []),
    ...(!creating && was.status !== will.status ? [line('Status', state(was.status), state(will.status))] : []),
  ];
  const action = { create: 'Add', update: 'Edit', complete: 'Complete', reopen: 'Reopen' }[p.args.action];
  return [
    'Google task change to review',
    `Action: ${action}`, `Account: ${p.account.email}`, `List: ${p.list.title}`,
    ...(was ? [`Task: ${text(was.title)}`] : []),
    'Changes:', ...(changes.length ? changes : ['- Nothing differs from the current task']),
    `Reason: ${p.args.reason}`,
  ].join('\n');
};

// Provider adapter only. The shared approval desk owns owner authentication, cards,
// proposal expiry and lifecycle. The existing effect ledger owns dispatch/recovery.
export const googleTaskApprovals = (deps: Readonly<{ sql: SqlStorage; google: GoogleAccess; effects: OwnerEffectLedger; ownerRef: () => string; ownerRefAliases?: () => readonly string[] }>) => {
  if (!deps.ownerRef || !deps.effects) throw new Error('Google task owner effect custody is required');
  deps.sql.exec('CREATE TABLE IF NOT EXISTS google_task_effect_ack (operation_id TEXT PRIMARY KEY, identity TEXT NOT NULL, task_json TEXT NOT NULL)');
  const acknowledgement = (operationId: string) => deps.sql.exec<Ack>('SELECT identity, task_json FROM google_task_effect_ack WHERE operation_id = ?', operationId).toArray()[0];
  const saveAck = (operationId: string, identity: string, task: GoogleTaskResource) => {
    const prior = acknowledgement(operationId);
    const json = JSON.stringify(task);
    if (prior && (prior.identity !== identity || prior.task_json !== json)) throw new Error('Google task acknowledgement identity conflict');
    if (!prior) deps.sql.exec('INSERT INTO google_task_effect_ack (operation_id, identity, task_json) VALUES (?, ?, ?)', operationId, identity, json);
  };
  return {
    async prepare(approvalId: string, input: ProposeGoogleTaskChangeArgs, ctx?: GoogleTaskSourceGuard): Promise<GoogleTaskProposal> {
      if (!approvalId) throw new Error('Google task approval identity required');
      const args = proposeGoogleTaskChangeArgsSchema.parse(input);
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      const selected = await deps.google.client('tasks', { id: `approval:${approvalId}:apply` }, ctx?.assertTaskSourceCurrent, args.account);
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      if (!selected) throw new GoogleTaskConnectorUnavailableError();
      if (!selected?.account?.connection_id || !selected.account.email || args.account && selected.account.email.toLowerCase() !== args.account.toLowerCase()) throw new Error('The selected Google task account is unavailable');
      const client = taskSourceClient(selected, ctx);
      if (!client.taskList || !client.task || !client.createTask || !client.patchTask) throw new Error('Google task approval operations are unavailable on this connector');
      const list = await client.taskList(args.task_list_id);
      const before = args.action === 'create' ? null : googleTaskResourceSchema.parse(await client.task(args.task_list_id, args.task_id!));
      if (before?.deleted) throw new Error('The Google task was deleted; no proposal was prepared');
      if (before?.assigned) throw new Error('Assigned Google tasks require review on their originating Docs or Chat surface');
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      return googleTaskProposalSchema.parse({ args, account: selected.account, list, before });
    },
    // Shared Work recovery reads exact ACK/version evidence; it never repeats a
    // Tasks mutation or guesses an accepted create from a matching title.
    async reconcile(approvalId: string, input: GoogleTaskProposal, operationRef = input.operation_ref ?? `approval:${approvalId}`, ctx?: GoogleTaskSourceGuard): Promise<EffectReadback> {
      const p = googleTaskProposalSchema.parse(input);
      if (!approvalId || !operationRef) throw new Error('Google task approval identity required');
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      const selected = await deps.google.client('tasks', { id: `approval:${approvalId}:apply`, requireRoute: true }, ctx?.assertTaskSourceCurrent, p.account.email);
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      if (!selected || !sameAccount(selected, p.account)) throw new Error('The approved Google task account or connection changed; nothing was retargeted');
      const client = taskSourceClient(selected, ctx);
      if (!client.task) throw new Error('Google task effect readback is unavailable');
      const identity = await sha256Hex(JSON.stringify(p));
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      const ack = acknowledgement(`${operationRef}:apply`);
      if (!ack || ack.identity !== identity) return { status: 'unknown' };
      const acknowledged = googleTaskResourceSchema.parse(JSON.parse(ack.task_json));
      const current = googleTaskResourceSchema.parse(await client.task(p.args.task_list_id, acknowledged.id));
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      if (current.etag !== acknowledged.etag || JSON.stringify(current) !== JSON.stringify(acknowledged) || !matchesFinal(p, current)) return { status: 'unknown' };
      return { status: 'done', receipt: { provider_id: current.id, result: { status: 'applied', readback_verified: true, account: p.account, task: current } satisfies TaskResult } };
    },
    async apply(approvalId: string, input: GoogleTaskProposal, operationRef = input.operation_ref ?? `approval:${approvalId}`, ctx?: GoogleTaskSourceGuard): Promise<GoogleTaskApplyOutcome> {
      const p = googleTaskProposalSchema.parse(input);
      if (!approvalId || !operationRef) throw new Error('Google task approval identity required');
      const operationId = `${operationRef}:apply`;
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      const selected = await deps.google.client('tasks', { id: `approval:${approvalId}:apply`, requireRoute: true }, ctx?.assertTaskSourceCurrent, p.account.email);
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      if (!selected || !sameAccount(selected, p.account)) throw new Error('The approved Google task account or connection changed; nothing was retargeted');
      const client = taskSourceClient(selected, ctx);
      if (!client.task || !client.createTask || !client.patchTask) throw new Error('Google task effect recovery is unavailable on this connector');
      const identity = await sha256Hex(JSON.stringify(p));
      // The digest is asynchronous; a revoked decision cannot reserve fresh custody.
      if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
      const receiptFor = (task: GoogleTaskResource): EffectReceipt => ({ provider_id: task.id, result: { status: 'applied', readback_verified: true, account: p.account, task } satisfies TaskResult });
      const verify = async (): Promise<EffectReceipt | null> => {
        const ack = acknowledgement(operationId);
        if (!ack || ack.identity !== identity) return null;
        const acknowledged = googleTaskResourceSchema.parse(JSON.parse(ack.task_json));
        const current = googleTaskResourceSchema.parse(await client.task!(p.args.task_list_id, acknowledged.id));
        if (current.etag !== acknowledged.etag || JSON.stringify(current) !== JSON.stringify(acknowledged) || !matchesFinal(p, current)) return null;
        return receiptFor(current);
      };
      const origin = deps.sql.exec<{origin_run_ref:string|null}>('SELECT origin_run_ref FROM ledger WHERE id = ?', approvalId).toArray()[0]?.origin_run_ref ?? undefined;
      try {
        const ownerRef = deps.ownerRef();
        if (!ownerRef) throw new Error('Google task owner effect custody is required');
        const receipt = await deps.effects.execute({ operationId, owner_ref: ownerRef, tool: 'google_task_change', payload: p }, {
          dispatch: async () => {
            // Nothing has been sent yet, so a failure here is not an unknown outcome: it is
            // closed as not applied and the owner asks again.
            let current: GoogleTaskResource | null = null;
            try {
              if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
              if (p.before) current = googleTaskResourceSchema.parse(await client.task!(p.args.task_list_id, p.args.task_id!));
            } catch { return { provider_id: p.before?.id ?? operationId, result: { status: 'not_applied', readback_verified: false, account: p.account, task: p.before } satisfies TaskResult }; }
            if (p.before && current && (current.etag !== p.before.etag || JSON.stringify(current) !== JSON.stringify(p.before))) return { provider_id: p.before.id, result: { status: 'stale', readback_verified: false, account: p.account, task: current } satisfies TaskResult };
            let ack: GoogleTaskResource;
            try { ack = googleTaskResourceSchema.parse(p.args.action === 'create' ? await client.createTask!(p.args.task_list_id, p.args.changes!) : await client.patchTask!(p.args.task_list_id, p.args.task_id!, patchFor(p), p.before!.etag)); }
            catch (error) {
              // A completed conditional request with 412 is authoritative rejection,
              // not a response-lost effect. Never downgrade an unknown transport error.
              if (p.before && error instanceof GoogleError && error.status === 412) return { provider_id: p.before.id, result: { status: 'stale', readback_verified: false, account: p.account, task: p.before } satisfies TaskResult };
              throw error;
            }
            // Commit the acknowledged target/version before the independent GET can fail.
            saveAck(operationId, identity, ack);
            const verified = await verify();
            if (!verified) throw new EffectUnknownError();
            if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
            return verified;
          },
          reconcile: async () => { if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent(); const receipt = await verify(); if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent(); return receipt ? { status: 'done', receipt } : { status: 'unknown' }; },
        }, origin, deps.ownerRefAliases?.());
        if (ctx?.assertTaskSourceCurrent) await ctx.assertTaskSourceCurrent();
        const result = receipt.result as TaskResult;
        return { status: result.status === 'applied' ? 'done' : result.status, receipt };
      } catch (error) {
        if (error instanceof EffectUnknownError || error instanceof GoogleError && error.message === 'intent_pending') return { status: 'unknown' };
        throw error;
      }
    },
  };
};
export type GoogleTaskApprovalAdapter = ReturnType<typeof googleTaskApprovals>;
