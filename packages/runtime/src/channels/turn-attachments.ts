import { ATTACH_FILE_MAX_PER_TURN } from '@waldo/contracts';
import type { WorkspaceStore } from '@waldo/workspace';
import { sha256Hex } from '../connectors/google';
import { EffectNotAppliedError, type OwnerEffectLedger } from './owner-effect-ledger';
import { workspaceDelivery, type WorkspaceDeliveryOptions } from './workspace-delivery';

// A workspace file the model queued to go out with its turn's reply. Names the file only; the bytes are read at send time.
export type TurnAttachment = Readonly<{ file_id: string; revision: number; filename: string; mime: string }>;
export type OutboundFile = Readonly<{ bytes: Uint8Array; mime: string; filename: string }>;
// degraded: a link text went out instead of the file. held: the surface holds that link text for later; nothing was delivered.
export type AttachmentOutcome =
  | Readonly<{ status: 'sent'; providerMessageId: string }>
  | Readonly<{ status: 'degraded' | 'held'; reason: string }>
  | Readonly<{ status: 'blocked' }>;
// A surface that carries files. A file it cannot carry goes as a text built from the fallback, which is read only then.
export type AttachmentSend = (file: OutboundFile, fallback: () => Promise<string>) => Promise<AttachmentOutcome>;

// Turns run one at a time per owner; a turn's queue lives until the turn sends it or ends. A restarted DO never replays a
// turn, so a queue lost with the process is a reply whose files were never promised a send.
export const turnAttachmentBook = () => {
  const queued = new Map<string, TurnAttachment[]>();
  return {
    queue(trace: string, attachment: TurnAttachment): number | 'limit_reached' {
      const files = queued.get(trace) ?? [];
      const known = files.some(file => file.file_id === attachment.file_id && file.revision === attachment.revision);
      if (!known && files.length >= ATTACH_FILE_MAX_PER_TURN) return 'limit_reached';
      if (!known) queued.set(trace, [...files, attachment]);
      return ATTACH_FILE_MAX_PER_TURN - (queued.get(trace)?.length ?? 0);
    },
    take(trace: string): TurnAttachment[] { const files = queued.get(trace) ?? []; queued.delete(trace); return files; },
    clear(trace: string): void { queued.delete(trace); },
  };
};
export type TurnAttachmentBook = ReturnType<typeof turnAttachmentBook>;

// Each file is its own effect: the intent is reserved before any read or send, keyed by owner, turn and file revision.
// WhatsApp cannot be asked whether an upload landed, so a send that started and did not finish stays unknown and is never
// retried; a send refused before it started (blocked, or the file gone) is not applied. The first failure stops the rest
// and propagates, so the surface tells the owner to check rather than claiming the files went out. A link the surface
// holds for later is not a failure: no file went out, so the intent is not applied, and the next file is tried.
export const deliverTurnAttachments = async (attachments: readonly TurnAttachment[], deps: Readonly<{
  trace: string; ownerRef: string; effects: OwnerEffectLedger; open(): Promise<WorkspaceStore>; send: AttachmentSend; delivery?: WorkspaceDeliveryOptions;
  // The turn's run admission: a run that closed (unlinked, rebound, past its deadline) sends nothing more.
  admit?(): void;
}>): Promise<void> => {
  for (const attachment of attachments) {
    const operationId = `attach:${await sha256Hex(JSON.stringify([deps.ownerRef, deps.trace, attachment.file_id, attachment.revision]))}`;
    let dispatched = false, sendStarted = false, blocked = false, held = false;
    const done = deps.effects.execute({ operationId, owner_ref: deps.ownerRef, tool: 'attach_file', payload: { trace: deps.trace, file_id: attachment.file_id, revision: attachment.revision } }, {
      dispatch: async () => {
        dispatched = true;
        const store = await deps.open();
        const { bytes } = await store.export(attachment.file_id, attachment.revision);
        const fallback = async () => {
          const link = await workspaceDelivery(store, attachment, deps.delivery);
          return link.url ? `Open it here: ${link.url}` : 'It is saved in your workspace.';
        };
        deps.admit?.();
        sendStarted = true;
        const outcome = await deps.send({ bytes, mime: attachment.mime, filename: attachment.filename }, fallback);
        if (outcome.status === 'blocked') { blocked = true; throw new Error('attachment send blocked'); }
        if (outcome.status === 'held') { held = true; throw new Error('attachment link held'); }
        return { provider_id: outcome.status === 'sent' ? outcome.providerMessageId : `degraded:${outcome.reason}`, result: outcome };
      },
      // Only this process's own attempt can say nothing left; an attempt found on restart stays unknown.
      reconcile: async () => ({ status: dispatched && (!sendStarted || blocked || held) ? 'not_applied' : 'unknown' }),
    });
    try { await done; }
    catch (error) { if (!held || !(error instanceof EffectNotAppliedError)) throw error; }
  }
};
