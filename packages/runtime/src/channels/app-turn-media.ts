import type { WorkspaceStore } from '@waldo/workspace';
import { LLM_ATTACHMENTS_MAX, llmAttachmentSchema, type LLMAttachment } from '@waldo/contracts';
import type { AppMediaFileRefV1, AppVoiceReviewV1 } from '../../../contracts/src/app/media';
import type { OwnerTurnEnvelope } from './owner-turn-envelope';
import { toBase64, type Transcriber } from './telegram-media';

type ResolvedFile = Awaited<ReturnType<WorkspaceStore['export']>>;
const images = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const audio = new Set(['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm']);
export class AppMediaError extends Error { constructor(readonly code: 'media_unavailable' | 'media_invalid' | 'media_too_large') { super(code); } }
export type AppTurnMediaHost = Readonly<{
  workspace(): Promise<Pick<WorkspaceStore, 'export'>>;
  assertCurrent(): Promise<void>;
  transcribe?: Transcriber;
}>;
const resolve = async (host: AppTurnMediaHost, reference: AppMediaFileRefV1): Promise<ResolvedFile> => {
  await host.assertCurrent();
  const store = await host.workspace(), file = await store.export(reference.file_id, reference.revision);
  await host.assertCurrent();
  if (file.meta.file_id !== reference.file_id || file.meta.revision !== reference.revision) throw new AppMediaError('media_invalid');
  if (file.bytes.byteLength > 10 * 1024 * 1024) throw new AppMediaError('media_too_large');
  return file;
};
// Validate before durable admission; bytes remain in their existing owner workspace.
export async function validateAppTurnMedia(host: AppTurnMediaHost, refs: readonly AppMediaFileRefV1[], voice?: AppVoiceReviewV1): Promise<void> {
  if (refs.length > LLM_ATTACHMENTS_MAX) throw new AppMediaError('media_invalid');
  if (new Set(refs.map(ref => `${ref.file_id}:${ref.revision}`)).size !== refs.length) throw new AppMediaError('media_invalid');
  for (const reference of refs) { const file = await resolve(host, reference); if (audio.has(file.meta.mime)) throw new AppMediaError('media_invalid'); }
  if (voice) {
    const file = await resolve(host, voice.original);
    if (!audio.has(file.meta.mime) || voice.processing === 'transcribe' && !host.transcribe) throw new AppMediaError('media_unavailable');
  }
}
export async function loadAppTurnMedia(host: AppTurnMediaHost, refs: readonly AppMediaFileRefV1[], sourceMessageId: string, voice?: AppVoiceReviewV1): Promise<Pick<OwnerTurnEnvelope, 'attachments' | 'attachmentRefs' | 'mediaNote'>> {
  await validateAppTurnMedia(host, refs, voice);
  const attachments: LLMAttachment[] = [], attachmentRefs: NonNullable<OwnerTurnEnvelope['attachmentRefs']>[number][] = [];
  const reference = (ref: AppMediaFileRefV1, file: ResolvedFile, nativeVoice: boolean) => ({
    reference: `workspace:${ref.file_id}:${ref.revision}`, sourceMessageId,
    filename: file.meta.path.split('/').at(-1)!, mimeType: file.meta.mime,
    byteLength: file.bytes.byteLength, sha256: file.meta.sha256, kind: nativeVoice ? 'audio' : images.has(file.meta.mime) ? 'image' : 'document', nativeVoice,
  });
  for (const ref of refs) {
    const file = await resolve(host, ref);
    attachments.push(llmAttachmentSchema.parse({ kind: images.has(file.meta.mime) ? 'image' : 'file', mime_type: file.meta.mime,
      filename: file.meta.path.split('/').at(-1)!, data_base64: toBase64(file.bytes) }));
    attachmentRefs.push(reference(ref, file, false));
  }
  let mediaNote: string | undefined;
  if (voice) {
    const file = await resolve(host, voice.original);
    const text = voice.processing === 'owner_reviewed' ? voice.transcript! : await host.transcribe!(file.bytes, file.meta.path.split('/').at(-1)!, file.meta.mime);
    await host.assertCurrent();
    if (!text.trim() || text.length > 32_000) throw new AppMediaError('media_unavailable');
    mediaNote = `[Original voice: workspace:${voice.original.file_id}:${voice.original.revision}. ${voice.processing === 'owner_reviewed' ? 'Owner-reviewed transcript' : 'Machine transcript, may contain errors'}: ${text}]`;
    attachmentRefs.push(reference(voice.original, file, true));
  }
  return { ...(attachments.length ? { attachments } : {}), ...(attachmentRefs.length ? { attachmentRefs } : {}), ...(mediaNote ? { mediaNote } : {}) };
}
