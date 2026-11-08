import { createOwnerTurnContext, surfaceChatRef, type OwnerContextSources } from '../context-composer/owner-turn';
import type { ContextHealthMaterial } from '../context-composer/types';
import type { TimelineSeed } from '../conversation/one-timeline';
import { commonOwnerAuthority } from '../identity/common-owner-authority';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { ownerPrincipalRef } from './app-api';
import { surfaceOwnerAdmission, type SurfaceOwnerBinding } from '../identity/surface-owner-admission';
import { COMPACTION_BUDGET_MS } from '../llm/time-budget';
import type { OwnerContextCapability } from '../context-composer/owner-turn';
import type { OwnerContextIntegration, OwnerHistoryFactory } from './owner-turn';
import { ClosedRunError, type RunEffectScope } from './run-effect-scope';
import type { TurnLogEntry } from './telegram-listener';

// The owner's chat turns on the one timeline: admitted as the owner the directory binds to the chat, run on the owner's own
// chain (the one their app chat uses), and followed by the same compaction as app turns. WhatsApp's context host lives here;
// Telegram's is the owner object's own, which joins the same chain.
export type ChatTimelineHost = Readonly<{ env: OwnerDirectoryEnv; kv: Pick<DurableObjectStorage['kv'], 'get'>; physicalDoId: string; commit<T>(work: () => T): T }>;
// The chat surfaces whose owner turns can run on the owner's own chain.
export type TimelineChat = 'whatsapp' | 'telegram';

const bound = (host: ChatTimelineHost, chat: TimelineChat) => {
  const doName = host.kv.get<string>('do_name'), subject = host.kv.get<string>(`${chat}_subject`);
  return doName && subject ? { doName, subject } : null;
};

// The owner the directory binds to this number now, read again for every authority check under the scope.
const ownerLookup = (host: ChatTimelineHost, scope: RunEffectScope, chat: TimelineChat, subject: string, doName: string) => async (): Promise<SurfaceOwnerBinding> => {
  scope.admit();
  const authority = await commonOwnerAuthority(host.env).resolve(chat, subject, doName);
  scope.admit();
  const pinned = host.kv.get<string>('owner_principal_ref');
  if (!authority || (pinned !== undefined && pinned !== ownerPrincipalRef(authority.directoryOwnerId))) throw new ClosedRunError();
  return { ownerId: authority.directoryOwnerId, bindingRef: authority.presenceId, revision: authority.admissionRevision, physicalDoId: host.physicalDoId };
};

const admit = async (host: ChatTimelineHost, scope: RunEffectScope, chat: TimelineChat, owner: Readonly<{ subject: string; doName: string }>, occurredAt: number, text: string) =>
  surfaceOwnerAdmission({ scope, lookup: ownerLookup(host, scope, chat, owner.subject, owner.doName), expectedPhysicalDoId: host.physicalDoId, surface: chat,
    subject: owner.subject, occurrenceKey: scope.runId, occurredAt, text });

// The turn's context leaves its chain to the default, the owner's own.
export const whatsappTimelineContext = (host: ChatTimelineHost, active: () => Readonly<{ scope: RunEffectScope; admittedAt: number }> | null,
  sources: Pick<OwnerContextSources, 'ownerProfile'> & Readonly<{ health(trace: string): Promise<ContextHealthMaterial | null> }>,
  history: OwnerHistoryFactory, timelineSeed: TimelineSeed, joined: () => boolean): OwnerContextIntegration => ({
  contextHost: { prepare: async (turn, scope) => {
    // A turn left out keeps the WhatsApp chain it ran on before.
    if (!turn.text || !joined()) return undefined;
    const running = active(), owner = bound(host, 'whatsapp');
    if (!running || scope !== running.scope || !owner || turn.conversationRef !== surfaceChatRef('whatsapp', owner.subject)) throw new ClosedRunError();
    // The composer runs on every tool round; one health read serves the whole turn.
    let health: Promise<ContextHealthMaterial | null> | undefined;
    return createOwnerTurnContext(await admit(host, scope, 'whatsapp', owner, running.admittedAt, turn.text),
      { health: () => health ??= sources.health(turn.traceId), ...(sources.ownerProfile ? { ownerProfile: sources.ownerProfile } : {}) });
  } },
  history, timelineSeed,
});

// After the owner's turns on a chat surface on the timeline, so an owner there who only writes on that chat still gets the
// summary that carries their chats from before. It runs in its own budget, never inside a turn.
export const compactChatTimeline = async (host: ChatTimelineHost, chat: TimelineChat,
  runtime: Readonly<{ compactChain(trace: string, context: OwnerContextCapability, scope: RunEffectScope): Promise<void>; log(entry: TurnLogEntry): void }>,
  abort: AbortController, alarmEnd?: number): Promise<void> => {
  const owner = bound(host, chat);
  if (!owner) return;
  const started = Date.now(), deadline = started + COMPACTION_BUDGET_MS;
  if (alarmEnd !== undefined && alarmEnd < deadline) return;
  const trace = `compaction:${chat}:${started}`, timer = setTimeout(() => abort.abort(), COMPACTION_BUDGET_MS);
  // Like a turn's scope: the chat must still be the bound, linked one under the same owner name when anything commits.
  const within = () => {
    if (abort.signal.aborted || Date.now() >= deadline || host.kv.get<string>(`${chat}_subject`) !== owner.subject || host.kv.get<boolean>(`${chat}_unlinked`) === true
      || host.kv.get<string>('do_name') !== owner.doName) throw new ClosedRunError();
  };
  const scope: RunEffectScope = { runId: trace, attempt: trace, deadline, signal: abort.signal, admit: within, commit: work => host.commit(() => { within(); return work(); }) };
  try { await runtime.compactChain(trace, createOwnerTurnContext(await admit(host, scope, chat, owner, started, 'Compact this conversation.')), scope); }
  catch (error) { runtime.log({ trace, hop: 'compaction', ms: Date.now() - started, ok: false, code: error instanceof ClosedRunError ? 'closed' : 'unavailable' }); }
  finally { clearTimeout(timer); abort.abort(); }
};
