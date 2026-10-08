import type { OwnerEffectLedger } from '../../channels/owner-effect-ledger';
import { TOOL_PERMISSIONS, WORKSPACE_TEXT_MAX_BYTES, triggerTypeSchema, workspaceRenderArgsSchema, type ToolHandler, type WorkspaceRenderArgs } from '@waldo/contracts';
import { WorkspaceError, type FileMeta, type WorkspaceStore } from '@waldo/workspace';
import type { ToolDispatcherContext } from '../dispatcher';
import { renderWorkspaceDocument } from '../../channels/document-render';
import { workspaceDelivery, type WorkspaceDeliveryOptions } from '../../channels/workspace-delivery';
import { workspaceOperationId } from './workspace-operation';

export const workspaceRenderHandler = (open: (ctx?: ToolDispatcherContext) => Promise<WorkspaceStore>, delivery?: WorkspaceDeliveryOptions, effects?: OwnerEffectLedger) => ({
  name: 'workspace_render',
  description: 'Create a real PDF or Word DOCX file from a saved text/plain or text/markdown workspace revision. Source limit is 32,000 UTF-8 bytes. PDF supports Latin text only and rejects unsupported characters; DOCX preserves Unicode. path must end in .pdf or .docx matching format. expected_revision 0 creates, N replaces that target revision. No HTML execution, remote images or URL fetching. Only report a download URL returned by delivery; saved_internal has no link.',
  schema: workspaceRenderArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter(t => TOOL_PERMISSIONS[t].includes('workspace_render')),
  autonomy_gated: false,
  mutates_state: true,
  handle: async (args: WorkspaceRenderArgs, ctx?: ToolDispatcherContext) => {
    if (!ctx?.turnId || !ctx.toolCallId) return { ok: false as const, code: 'rejected' as const, error: 'Render invocation identity is unavailable.' };
    if (!args.path.endsWith(`.${args.format}`)) return { ok: false as const, code: 'invalid_args' as const, error: 'Output path extension must match the requested document format.' };
    // Include the validated source/target tuple: reconciliation cannot mistake another render
    // intent for this one, and nondeterministic library ZIP/PDF timestamps never break a retry.
    const operation_id = await workspaceOperationId([ctx.authenticatedUserId, ctx.turnId, ctx.toolCallId, args.source_file_id, args.source_revision, args.path, args.expected_revision, args.format], 'workspace_render');
    try {
      const store = await open(ctx); await ctx.assertTaskSourceCurrent?.(); ctx.runScope?.admit();
      let meta: FileMeta;
      try {
        if (effects?.get(operation_id)) {
          meta = (await effects.execute({ operationId: operation_id, owner_ref: ctx.authenticatedUserId, tool: 'workspace_render', payload: args }, {
            dispatch: async () => { throw Error('render intent cannot be replayed'); },
            reconcile: async () => { const result = await store.reconcile(operation_id); return { status: 'done', receipt: { provider_id: result.file_id, result } }; },
          })).result as FileMeta;
        } else meta = await store.reconcile(operation_id);
      }
      catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== 'not_found') throw error;
        await ctx.assertTaskSourceCurrent?.();
        const source = await store.export(args.source_file_id, args.source_revision, WORKSPACE_TEXT_MAX_BYTES);
        await ctx.assertTaskSourceCurrent?.();
        if (!['text/plain', 'text/markdown'].includes(source.meta.mime)) return { ok: false as const, code: 'invalid_args' as const, error: 'Document source must be text/plain or text/markdown.' };
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.bytes); }
        catch { return { ok: false as const, code: 'invalid_args' as const, error: 'Document source is not valid UTF-8 text.' }; }
        const rendered = await renderWorkspaceDocument(text, args.format);
        ctx.runScope?.admit();
        if (rendered.status !== 'exported') return { ok: false as const, code: 'rejected' as const, error: `Document render ${rendered.status}. Nothing was written.` };
        await ctx.assertTaskSourceCurrent?.();
        const write = () => store.write({ path: args.path, bytes: rendered.bytes, mime: rendered.mime, expected_revision: args.expected_revision, operation_id, provenance: 'agent_generated' });
        meta = effects ? (await effects.execute({ operationId: operation_id, owner_ref: ctx.authenticatedUserId, tool: 'workspace_render', payload: args }, {
          dispatch: async () => { const result = await write(); return { provider_id: result.file_id, result }; },
          reconcile: async () => { const result = await store.reconcile(operation_id); return { status: 'done', receipt: { provider_id: result.file_id, result } }; },
        })).result as FileMeta : await write();
      }
      ctx.runScope?.admit();
      const delivered = await workspaceDelivery(store, meta, delivery);
      ctx.runScope?.admit();
      return { ok: true as const, source_taint: null, data: { status: 'exported', file_id: meta.file_id, revision: meta.revision, byte_size: meta.byte_size, sha256: meta.sha256, mime: meta.mime, source_file_id: args.source_file_id, source_revision: args.source_revision, delivery: delivered } };
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : 'unavailable';
      return { ok: false as const, code: code === 'invalid' ? 'invalid_args' as const : code === 'not_found' ? 'not_found' as const : code === 'quota' || code === 'capacity' ? 'oversize' as const : code === 'rejected' || code === 'conflict' ? 'rejected' as const : 'transient' as const, error: code === 'quota' ? 'Source exceeds 32,000 UTF-8 bytes or workspace storage quota is full.' : code === 'conflict' ? 'Target revision conflict: re-read the file and retry with its current revision.' : `Document render workspace_${code}. No completed export receipt is available.` };
    }
  },
} satisfies ToolHandler<WorkspaceRenderArgs, unknown, ToolDispatcherContext>);
