import { env } from 'cloudflare:workers';
import { claimStore } from '../../src/memory/claims';
import { memoryHandlers, type MemoryToolContext } from '../../src/tools/live/memory';

// An owner's memory with the people map on (or off), and the memory tools over it. Synthetic people only.
export const OWNER = 'owner:1';
const CHAT = 'app:main';
export const stub = (name: string) => env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`people-map-${name}`));
export const world = (state: DurableObjectState, people = true) => {
  const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
  const hidden: string[][] = [];
  const handlers = memoryHandlers({ sql: state.storage.sql, store, conversationRef: CHAT, now: () => new Date('2026-11-07T09:00:00Z'), transaction: work => state.storage.transactionSync(work),
    hideHistory: async texts => { hidden.push([...texts]); }, ...(people ? { people: true } : {}) });
  const ctx = (text: string, over: Partial<MemoryToolContext> = {}): MemoryToolContext => ({ authenticatedUserId: OWNER, trigger: 'user_message',
    memoryTurn: { ownerId: OWNER, conversationRef: CHAT, current: { message_ref: `m-${text.length}`, text }, recent: [] }, ...over } as unknown as MemoryToolContext);
  const call = async (name: string, args: unknown, context: MemoryToolContext) => { const handler = handlers.find(h => h.name === name)!; return handler.handle(handler.schema.parse(args), context); };
  const data = async (name: string, args: unknown, context: MemoryToolContext) => { const result = await call(name, args, context); if (!result.ok) throw new Error(result.error); return result.data as Record<string, unknown>; };
  return { store, hidden, ctx, call, data };
};
export type Card = { person: number; name: string; ring: string | null; relations: string[]; next_date: { date: string; text: string } | null; claims: number };
