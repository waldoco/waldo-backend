import type { ConversationEntry } from './conversation-entry';
import { ConversationTree } from './conversation-entry';

export type ConversationExport = Readonly<{
  version: 1;
  ownerId: string;
  chatId: string;
  leafId: string;
  generatedAt: number;
  entries: readonly Readonly<{
    id: string;
    parentId: string | null;
    threadAnchorId: string | null;
    surface: string;
    appPayload: string;
  }>[];
}>;

export function exportConversation(input: Readonly<{
  authenticatedOwnerId: string;
  chatId: string;
  leafId: string;
  generatedAt: number;
  entries: readonly ConversationEntry[];
}>): ConversationExport {
  const tree = new ConversationTree();
  for (const entry of input.entries) {
    if (entry.ownerId !== input.authenticatedOwnerId || entry.chatId !== input.chatId) {
      throw new Error('conversation export boundary mismatch');
    }
    tree.append(entry);
  }
  const path = tree.path(input.leafId);
  const leaf = path.at(-1);
  if (!leaf || leaf.ownerId !== input.authenticatedOwnerId || leaf.chatId !== input.chatId) {
    throw new Error('conversation export leaf mismatch');
  }
  return Object.freeze({
    version: 1,
    ownerId: input.authenticatedOwnerId,
    chatId: input.chatId,
    leafId: input.leafId,
    generatedAt: input.generatedAt,
    entries: Object.freeze(path.map((entry) => Object.freeze({
      id: entry.id,
      parentId: entry.parentId,
      threadAnchorId: entry.threadAnchorId,
      surface: entry.surface,
      appPayload: entry.appPayload,
    }))),
  });
}
