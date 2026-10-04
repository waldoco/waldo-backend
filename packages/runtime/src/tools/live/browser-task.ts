import { browserTaskContinuationSchema, browseActArgsSchema, type BrowseActArgs, type ToolHandler } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../dispatcher';
import type { BrowserSubmitProposal } from '../../channels/approvals';
import type { browserTaskContinuity } from '../../channels/browser-task-continuity';
import type { BrowserSubmitOutcome } from './browser';

export type BrowserTaskHost = ReturnType<typeof browserTaskContinuity>;
const rejected = (message: string) => ({ ok: false as const, code: 'rejected' as const, error: message, source_taint: 'external' as const });
// Register this single same-name handler instead of (not alongside) its legacy
// input handler. The host resolver is authenticated code, never model input.
export function browserTaskHandler(options: Readonly<{
  legacy: ToolHandler<BrowseActArgs, unknown, ToolDispatcherContext>;
  host(context: ToolDispatcherContext): Promise<BrowserTaskHost | null>;
  propose(payload: BrowserSubmitProposal, context: ToolDispatcherContext): Promise<string>;
  // Fence canonical independent admission before waiting for task cleanup mutex.
  stopAdmission?(context: ToolDispatcherContext, host: BrowserTaskHost): Promise<void>;
}>): ToolHandler<BrowseActArgs, unknown, ToolDispatcherContext> {
  return {
    ...options.legacy, schema: browseActArgsSchema,
    description: 'Browse a public page. Configured typed commands use observed field refs: inspect, fill, prepare_submit, verify or cancel. Final submit always needs the owner approval desk; typed commands never fall back to a fresh browser.',
    async handle(args, context) {
      if (!args.command) return options.legacy.handle(args, context);
      try {
        const source = context.assertTaskSourceCurrent;
        if (args.command.operation !== 'cancel') { if (!source) return rejected('Current task source admission is unavailable.'); await source(); }
        const host = await options.host(args.command.operation === 'cancel' ? { ...context, assertTaskSourceCurrent: undefined } : context);
        if (args.command.operation !== 'cancel') await source!();
        if (!host || args.url !== host.pageUrl) return rejected('No configured current browser task matches that page.');
        const owner = context.authenticatedUserId;
        const command = args.command;
        if (command.operation === 'inspect') {
          const snapshot = await host.read(owner);
          await source!();
          return { ok: true, data: { ...snapshot, field_refs: Object.keys(snapshot.binding) }, source_taint: 'external' };
        }
        if (command.operation === 'fill') { const data = await host.fill(owner, command.field_ref, command.value); await source!(); return { ok: true, data, source_taint: 'external' }; }
        if (command.operation === 'cancel') {
          if (!options.stopAdmission) return rejected('Browser stop admission is not configured.');
          await options.stopAdmission(context, host);
          return { ok: true, data: await host.cancel(owner), source_taint: 'external' };
        }
        if (command.operation === 'verify') { const data = await host.reconcile(owner); await source!(); return { ok: true, data, source_taint: 'external' }; }
        const prepared = await host.propose(owner);
        await source!();
        const payload: BrowserSubmitProposal = { url: prepared.url, action: { selector: prepared.actionRef, method: 'click', description: 'Submit the prepared public form' }, binding: prepared.binding, steps: [], continuation: { version: 1, taskRef: host.taskRef, proposalId: prepared.id, scopeDigest: prepared.scopeDigest } };
        const proposalId = await options.propose(payload, context);
        await source!();
        return { ok: true, data: { url: prepared.url, stopped: 'approval_pending', proposal_id: proposalId, binding: prepared.binding }, source_taint: 'external' };
      } catch { return rejected('The browser task could not be observed or updated. Inspect its current state before trying again.'); }
    },
  };
}
export function browserTaskApprovalBridge(options: Readonly<{
  ownerId: string | (() => string);
  host(payload: BrowserSubmitProposal): Promise<BrowserTaskHost | null>;
}>) {
  const ownerId = () => typeof options.ownerId === 'function' ? options.ownerId() : options.ownerId;
  const resolve = async (payload: BrowserSubmitProposal) => {
    const reference = browserTaskContinuationSchema.safeParse(payload.continuation);
    if (!reference.success) return null;
    let host: BrowserTaskHost | null;
    try { host = await options.host(payload); } catch { return null; }
    if (!host || host.taskRef !== reference.data.taskRef || host.pageUrl !== payload.url) return null;
    return { host, reference: reference.data };
  };
  return {
    async submit(payload: BrowserSubmitProposal, approvalRef?: string): Promise<BrowserSubmitOutcome> {
      const resolved = await resolve(payload);
      if (!resolved || !approvalRef) return { status: 'rejected', message: 'The prepared browser task or current owner approval is unavailable.' };
      if (!await resolved.host.validateProposal(ownerId(), resolved.reference, payload)) return { status: 'rejected', message: 'The prepared browser target or facts changed. Observe and approve it again.' };
      return resolved.host.submit(ownerId(), resolved.reference.proposalId, approvalRef);
    },
    async receiptVerified(payload: BrowserSubmitProposal, receipt: Extract<BrowserSubmitOutcome, { status: 'verified_with_receipt' }>['receipt']) {
      const resolved = await resolve(payload);
      return resolved !== null && await resolved.host.validateProposal(ownerId(), resolved.reference, payload) && await resolved.host.validateReceipt(ownerId(), resolved.reference.proposalId, receipt);
    },
  };
}
