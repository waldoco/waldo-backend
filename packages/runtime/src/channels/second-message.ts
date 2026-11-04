import {
  ownerMessageHeardArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type OwnerMessageHeardArgs, type OwnerMessageHeardResult, type ToolHandler, type ToolResult,
} from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';

// A second owner message while Waldo works (docs/proposals/WALDO_SECOND_MESSAGE_DESIGN_2026-10-31.md, design (a)). Every
// surface admits the newer message durably on its own inbox first. At each round of the running owner turn the host shows
// the model the messages waiting on the same chat, and the model answers with owner_message_heard: fold (this answer covers
// it, and it closes without a turn of its own), queue (it keeps its own turn after this one) or stop_current (it replaces
// this task: it closes like a fold, and this turn drops what it was doing and its one reply answers the newer message, with no
// line about the stop). A message the model never answers stays queued, so nothing is lost and nothing is folded without the
// model saying so. Off unless WALDO_SECOND_MESSAGE=1.

export const secondMessageEnabled = (env: Readonly<{ WALDO_SECOND_MESSAGE?: string }>): boolean => env.WALDO_SECOND_MESSAGE === '1';

export type WaitingMessage = Readonly<{ id: string; text: string; at: number }>;
// The running owner turn's chat on its surface: the owner's newer messages there still waiting to run, oldest first, and the
// fold, which closes one as answered by this turn. fold runs inside the turn's run-scope commit and answers false for a message
// no longer waiting.
export type OwnerChat = Readonly<{ turnId: string; waiting(): readonly WaitingMessage[]; fold(id: string): boolean }>;
export type SecondMessageRound = Readonly<{ note: string; folded: readonly WaitingMessage[] }>;
type Choice = OwnerMessageHeardArgs['choice'];

const NONE: SecondMessageRound = { note: '', folded: [] };
const clock = (at: number, timezone: string): string => {
  try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(at); } catch { return new Date(at).toISOString().slice(11, 16); }
};

export const secondMessages = (deps: Readonly<{ chat(): OwnerChat | null; timezone(): string }>) => {
  // One running owner turn at a time per owner object, so one slot; a new turn id starts it afresh.
  type Turn = { id: string; offered: Map<string, WaitingMessage>; chosen: Map<string, Choice>; unsaved: WaitingMessage[] };
  let turn: Turn | null = null;
  const slot = (chat: OwnerChat): Turn => turn?.id === chat.turnId ? turn : (turn = { id: chat.turnId, offered: new Map(), chosen: new Map(), unsaved: [] });

  const round = (): SecondMessageRound => {
    const chat = deps.chat();
    if (!chat) return NONE;
    const held = slot(chat);
    const waiting = chat.waiting();
    for (const message of waiting) if (!held.offered.has(message.id)) held.offered.set(message.id, message);
    // A message that stopped waiting without the model's word (the owner stopped it, its session ended) is not offered again.
    const live = new Set(waiting.map(message => message.id));
    for (const id of [...held.offered.keys()]) if (!live.has(id) && !held.chosen.has(id)) held.offered.delete(id);
    const folded = held.unsaved.splice(0);
    if (!held.offered.size) return { note: '', folded };
    const zone = deps.timezone();
    const lines = [...held.offered.values()].map(message => {
      const choice = held.chosen.get(message.id);
      const said = `${message.id} (${clock(message.at, zone)}): ${JSON.stringify(message.text)}`;
      return choice === 'fold' ? `- ${said} [you folded it in: answer it in this reply]` : choice === 'queue' ? `- ${said} [queued: it gets its own turn after this one]`
        : choice === 'stop_current' ? `- ${said} [it replaces what you were doing: drop that task and make this reply the answer to it]` : `- ${said}`;
    });
    const open = [...held.offered.keys()].some(id => !held.chosen.has(id));
    return {
      note: `\n\n[While you were working, the owner sent ${held.offered.size === 1 ? 'a newer message' : 'newer messages'} on this chat:\n${lines.join('\n')}`
        + (open ? '\nFor each one not yet answered, call owner_message_heard with its id: fold if it changes or adds to this task, so this answer covers it; queue if it is separate, so it gets its own turn after this one; stop_current if it replaces this task, so you drop that task and this reply answers it. One you leave unanswered is queued.]' : ']'),
      folded,
    };
  };

  const unheard = (reason: 'not_waiting' | 'not_owner_turn'): ToolResult<OwnerMessageHeardResult> => ({ ok: true, data: { heard: false, reason }, source_taint: null });
  const handler: ToolHandler<OwnerMessageHeardArgs, OwnerMessageHeardResult, ToolDispatcherContext> = {
    name: 'owner_message_heard',
    description: 'Say what to do with a newer message the owner sent on this chat while you work, by the id shown in the note. fold: it changes or adds to the task you are on, so your reply answers both, and it gets no turn of its own. queue: it is a separate ask, so it gets its own turn after this one. stop_current: it replaces what you are doing, so drop that task and make this reply the answer to it; it gets no turn of its own. heard:false with not_waiting means it is no longer waiting (already answered or stopped): carry on.',
    schema: ownerMessageHeardArgsSchema,
    trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('owner_message_heard')),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args, ctx) {
      const chat = deps.chat();
      if (ctx.trigger !== 'user_message' || ctx.ownerInitiated !== true || !chat || chat.turnId !== ctx.turnId) return unheard('not_owner_turn');
      const held = slot(chat);
      const message = chat.waiting().find(waiting => waiting.id === args.message_id);
      if (!message || held.chosen.has(message.id)) return unheard('not_waiting');
      if (args.choice === 'fold' || args.choice === 'stop_current') {
        const commit = ctx.runScope?.commit ?? (<T,>(work: () => T) => work());
        if (!commit(() => chat.fold(message.id))) return unheard('not_waiting');
        held.unsaved.push(message);
      }
      held.offered.set(message.id, message);
      held.chosen.set(message.id, args.choice);
      return { ok: true, data: { heard: true, choice: args.choice }, source_taint: null };
    },
  };
  return { round, handler };
};
export type SecondMessages = ReturnType<typeof secondMessages>;
