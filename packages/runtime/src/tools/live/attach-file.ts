import {
  ATTACH_FILE_MAX_PER_TURN, attachFileArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type AttachFileArgs, type AttachFileResult, type ToolHandler, type ToolResult,
} from '@waldo/contracts';
import { WorkspaceError, type WorkspaceStore } from '@waldo/workspace';
import { ClosedRunError } from '../../channels/run-effect-scope';
import type { TurnAttachmentBook } from '../../channels/turn-attachments';
import type { ToolDispatcherContext } from '../dispatcher';

const DESCRIPTION = 'Attach one of the owner\'s workspace files (file_id and its current revision, from a workspace receipt) to your reply in this chat. Use it when the owner wants the file itself, such as a PDF or DOCX you rendered. The file goes out after your reply, so say it is coming, never that it was sent. queued:true means it will follow your reply; a type or size this chat cannot carry, or a file the chat cannot send yet (WhatsApp outside its 24-hour window, or earlier messages still waiting), arrives as a message with the owner link instead, and that message may wait for the owner\'s next message. Otherwise: revision_changed, the file has a newer revision, current_revision; not_found, no such file; limit_reached, no more files this turn; not_owner_turn or unavailable, share the link from the file\'s receipt instead.';

const result = (data: AttachFileResult): ToolResult<AttachFileResult> => ({ ok: true, data, source_taint: null });

// Offered only on a surface that carries files. It reads the file's metadata to check it exists at the named revision and
// queues it for this turn; the host sends it after the reply. Nothing here sends or names a destination.
export const attachFileHandler = (deps: Readonly<{
  open(ctx: ToolDispatcherContext): Promise<WorkspaceStore>;
  book: TurnAttachmentBook;
}>): ToolHandler<AttachFileArgs, AttachFileResult, ToolDispatcherContext> => ({
  name: 'attach_file',
  description: DESCRIPTION,
  schema: attachFileArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('attach_file')),
  autonomy_gated: false,
  mutates_state: true,
  async handle(args, ctx) {
    if (ctx.trigger !== 'user_message' || ctx.ownerInitiated !== true || !ctx.turnId) return result({ queued: false, reason: 'not_owner_turn' });
    let meta: Awaited<ReturnType<WorkspaceStore['stat']>>;
    try {
      meta = await (await deps.open(ctx)).stat(args.file_id);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'invalid') return result({ queued: false, reason: 'not_found' });
      if (ctx.runScope && error instanceof ClosedRunError) throw error;
      return result({ queued: false, reason: 'unavailable' });
    }
    if (!meta) return result({ queued: false, reason: 'not_found' });
    if (meta.revision !== args.revision) return result({ queued: false, reason: 'revision_changed', current_revision: meta.revision });
    const filename = meta.path.split('/').at(-1) || meta.path;
    const left = deps.book.queue(ctx.turnId, { file_id: meta.file_id, revision: meta.revision, filename, mime: meta.mime });
    if (left === 'limit_reached') return result({ queued: false, reason: 'limit_reached', max_per_turn: ATTACH_FILE_MAX_PER_TURN });
    return result({ queued: true, filename, attachments_left: left });
  },
});
