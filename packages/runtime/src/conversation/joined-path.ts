import type { RunEffectScope } from '../channels/run-effect-scope';
import {
  ConversationTree,
  type ConversationEntry,
  type ConversationModelMessage,
  type TrustedInvocationEnvelope,
} from '@waldo/contracts';
import type { ContextComposer, RuntimeOwnedContextInputs } from '../context-composer';
import { windowModelMessages, type ConversationWindowStats } from './window';

export type JoinedConversationModel = Readonly<{
  complete(request: Readonly<{
    system: string;
    skillPrompt?: string;
    messages: readonly ConversationModelMessage[];
    tools: readonly string[];
    composition: Extract<import('../context-composer/types').ContextCompositionResult,{ok:true}>;
  }>): Promise<string>;
}>;

export type JoinedConversationRequest = Readonly<{
  runScope?: RunEffectScope;
  authenticatedOwnerId: string;
  invocation: TrustedInvocationEnvelope;
  context: RuntimeOwnedContextInputs;
  userEntry: ConversationEntry;
  assistantEntryId: string;
  historyStartRef?: string;
}>;

export type JoinedConversationPublication = Readonly<{
  ownerId: string;
  chatId: string;
  leafId: string;
  text: string;
  contextRef: string;
  promptDigest: string;
}>;

export class JoinedConversationPath {
  constructor(
    private readonly composer: ContextComposer,
    private readonly model: JoinedConversationModel,
    private readonly tree = new ConversationTree(),
    private readonly publications = new Map<string, JoinedConversationPublication>(),
    private readonly observers?: { onWindow?: (stats: ConversationWindowStats) => void },
  ) {}

  async submit(request: JoinedConversationRequest): Promise<JoinedConversationPublication> {
    if (request.userEntry.ownerId !== request.authenticatedOwnerId) {
      throw new Error('conversation owner authentication mismatch');
    }
    if (request.invocation.verified_authority.principal_ref !== request.authenticatedOwnerId) {
      throw new Error('conversation invocation owner mismatch');
    }
    const existing = this.publications.get(request.assistantEntryId);
    if (existing) return existing;

    request.runScope?.admit();
    const original = { ...request.userEntry, role: 'user' as const };
    const retained = this.tree.get(original.id);
    if (retained && JSON.stringify(retained) !== JSON.stringify(original)) throw Error('conversation original input conflict');
    if (!retained) this.tree.append(original);
    const composition = await this.composer.compose(request.invocation, request.context);
    if (!composition.ok) throw new Error(`conversation context failed: ${composition.failure.code}`);
    // F1: bound the model input before the call - the full ancestor path grows without limit
    // otherwise, and provider-side overflow is a failed turn (paper audit, arXiv 2609.20804).
    const history = taskHistoryMessages(this.tree, request.userEntry.id, request.historyStartRef);
    const windowed = windowModelMessages(history);
    this.observers?.onWindow?.(windowed.stats);
    request.runScope?.admit();
    const text = await this.model.complete({
      system: composition.prompt,
      ...(composition.skillPrompt ? { skillPrompt: composition.skillPrompt } : {}),
      messages: windowed.messages,
      tools: composition.evidence.tool_acl,
      composition,
    });
    if (text.trim().length === 0) throw new Error('conversation model returned empty output');
    const assistantEntry: ConversationEntry = {
      id: request.assistantEntryId,
      ownerId: request.userEntry.ownerId,
      chatId: request.userEntry.chatId,
      parentId: request.userEntry.id,
      threadAnchorId: request.userEntry.threadAnchorId,
      surface: request.userEntry.surface,
      modelPayload: text,
      appPayload: text,
      modelProjection: { mode: 'include' },
      role: 'assistant',
    };
    request.runScope?.admit();
    this.tree.append(assistantEntry);
    const publication = Object.freeze({
      ownerId: assistantEntry.ownerId,
      chatId: assistantEntry.chatId,
      leafId: assistantEntry.id,
      text,
      contextRef: composition.checkpoint.context_ref,
      promptDigest: composition.evidence.prompt_digest,
    });
    this.publications.set(assistantEntry.id, publication);
    return publication;
  }

  read(authenticatedOwnerId: string, entryId: string): JoinedConversationPublication | undefined {
    const publication = this.publications.get(entryId);
    if (!publication) return undefined;
    if (publication.ownerId !== authenticatedOwnerId) {
      throw new Error('conversation owner authentication mismatch');
    }
    return publication;
  }
}

export const taskHistoryMessages = (tree: ConversationTree, leafId: string, startRef?: string): readonly ConversationModelMessage[] => {
  if (!startRef) return tree.modelContext(leafId);
  const entries = tree.path(leafId);
  const first = entries.findIndex(entry => entry.id === startRef);
  const taskEntries = first < 0 ? entries.slice(-1) : entries.slice(first);
  const taskTree = new ConversationTree();
  taskEntries.forEach((entry, index) => taskTree.append({ ...entry, parentId: index === 0 ? null : entry.parentId }));
  return taskTree.modelContext(leafId);
};
