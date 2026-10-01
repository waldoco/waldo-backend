import { iMessageBindingSchema, iMessageEventSchema, opaqueIMessageIdSchema, LLM_ATTACHMENTS_MAX, type IMessageBinding, type IMessageEvent } from '@waldo/contracts';
import type { OwnerDirectory, OwnerRoute } from '../../identity/owner-directory';
import type { OwnerTurnEnvelope } from '../owner-turn-envelope';
import { admittedIMessageTurn } from './ingress';
import { loadIMessageMedia, type IMessageMediaDeps, type IMessageMediaStatus } from './media';

export type IMessageAdmissionGrant = Readonly<{ binding: IMessageBinding; revision: string; doName: string }>;
export type IMessageAdmissionAuthority = Readonly<{
  resolve(event: IMessageEvent): IMessageAdmissionGrant | null;
  current(grant: IMessageAdmissionGrant): boolean;
}>;
export type IMessageAdmissionDeps = Readonly<{
  authority?: IMessageAdmissionAuthority;
  directory: Pick<OwnerDirectory, 'byPresence'>;
  media?: IMessageMediaDeps;
}>;

export const admitIMessageOwnerTurn = async <T>(input: unknown, deps: IMessageAdmissionDeps,
  admitted: (route: OwnerRoute, turn: OwnerTurnEnvelope, media: readonly IMessageMediaStatus[]) => T): Promise<T> => {
  const event = iMessageEventSchema.parse(input);
  if (event.kind !== 'message' || event.isFromMe || event.isGroup || event.service !== 'iMessage') throw new Error('iMessage turn not admitted');
  const resolved = deps.authority?.resolve(event);
  if (!resolved) throw new Error('iMessage turn not admitted');
  const grant = Object.freeze({ binding: Object.freeze(iMessageBindingSchema.parse(resolved.binding)),
    revision: opaqueIMessageIdSchema.parse(resolved.revision), doName: opaqueIMessageIdSchema.parse(resolved.doName) });
  const check = () => { if (deps.authority?.current(grant) !== true) throw new Error('iMessage turn not admitted'); };
  const turn = admittedIMessageTurn(event, grant.binding);
  if (event.attachments.length > LLM_ATTACHMENTS_MAX) throw new Error('iMessage excess media');
  if (new Set(event.attachments.map(file => file.reference)).size !== event.attachments.length) throw new Error('iMessage ambiguous media');
  check();
  const lookedUp = await deps.directory.byPresence('imessage', grant.binding.subject);
  check();
  if (!lookedUp || lookedUp.doName !== grant.doName || lookedUp.subject !== grant.binding.subject) throw new Error('iMessage turn not admitted');
  const route = Object.freeze({ doName: lookedUp.doName, subject: lookedUp.subject, timezone: lookedUp.timezone });
  if (event.attachments.length && !deps.media) throw new Error('iMessage media unavailable');
  const media = event.attachments.length ? await loadIMessageMedia(event, grant, deps.media!, check) : { attachments: [], statuses: [] };
  check();
  return admitted(route, { ...turn, ...(media.attachments.length ? { attachments: media.attachments } : {}) }, media.statuses);
};
