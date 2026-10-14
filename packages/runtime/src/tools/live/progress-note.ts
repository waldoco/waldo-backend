import {
  PROGRESS_NOTE_MAX_CHARS, PROGRESS_NOTE_MAX_PER_TURN, PROGRESS_NOTE_MIN_GAP_MS, sendProgressNoteArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type SendProgressNoteArgs, type SendProgressNoteResult, type ToolHandler, type ToolResult,
} from '@waldo/contracts';
import { ClosedRunError, type RunEffectScope } from '../../channels/run-effect-scope';
import { redactSecretUrls } from '../../channels/egress-guard';
import { guardArtifactLinks } from '../../conversation/artifact-link-guard';
import type { TurnLogEntry } from '../../channels/owner-turn-types';
import type { ToolDispatcherContext } from '../dispatcher';

// The owner turn a note belongs to. The host sends to that turn's own chat; nothing here names a destination.
export type ProgressNoteTurn = Readonly<{ turnId: string; runScope?: RunEffectScope }>;
// True when the surface accepted the note; false when it refused or blocked the send.
export type ProgressNoteDeliver = (text: string, turn: ProgressNoteTurn) => Promise<boolean>;

const DESCRIPTION = 'Send the owner a short note in this chat while you keep working; your turn does not end. Use it on a task that will run past about a minute (searching, comparing, checking several sources) to say what you have found so far, what you are trying next, or that a source failed and you are switching. Never ask a question in a note: asking is your reply\'s job, and the reply ends the turn. No filler such as "working on it" or "almost done". Never say something is done, booked, sent or saved unless a tool result this turn shows it. Keep it to one or two plain sentences; your final reply must still give the whole answer. sent:true means the note is on its way. Otherwise: too_long, shorten it to max_chars; too_soon, keep working and wait wait_seconds before the next note; limit_reached, no more notes this turn; not_owner_turn or send_failed, carry on without one.';

const unsent = (data: Extract<SendProgressNoteResult, { sent: false }>): ToolResult<SendProgressNoteResult> => ({ ok: true, data, source_taint: null });

// The host enforces resource bounds only: a length cap, a gap between notes and a count per turn. Turns run one at a
// time per owner, so one slot holds the current turn's spend and a new turn id starts it afresh.
export const progressNoteHandler = (deps: Readonly<{
  deliver: ProgressNoteDeliver;
  now?: () => number;
  log?: (entry: Pick<TurnLogEntry, 'trace' | 'hop' | 'ms' | 'ok' | 'detail'>) => void;
}>): ToolHandler<SendProgressNoteArgs, SendProgressNoteResult, ToolDispatcherContext> => {
  const now = deps.now ?? Date.now;
  let spent: { turnId: string; count: number; lastAt: number } | undefined;
  return {
    name: 'send_progress_note',
    description: DESCRIPTION,
    schema: sendProgressNoteArgsSchema,
    trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('send_progress_note')),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args, ctx) {
      const started = now();
      const done = (result: ToolResult<SendProgressNoteResult>): ToolResult<SendProgressNoteResult> => {
        const data = result.ok ? result.data : undefined;
        deps.log?.({ trace: ctx.turnId ?? 'unknown', hop: 'progress_note', ms: now() - started, ok: data?.sent === true, detail: data?.sent === false ? data.reason : 'sent' });
        return result;
      };
      if (ctx.trigger !== 'user_message' || ctx.ownerInitiated !== true || !ctx.turnId) return done(unsent({ sent: false, reason: 'not_owner_turn' }));
      const turn: ProgressNoteTurn = { turnId: ctx.turnId, ...(ctx.runScope ? { runScope: ctx.runScope } : {}) };
      if (args.text.length > PROGRESS_NOTE_MAX_CHARS) return done(unsent({ sent: false, reason: 'too_long', max_chars: PROGRESS_NOTE_MAX_CHARS }));
      if (spent?.turnId !== turn.turnId) spent = { turnId: turn.turnId, count: 0, lastAt: -Infinity };
      const slot = spent;
      if (slot.count >= PROGRESS_NOTE_MAX_PER_TURN) return done(unsent({ sent: false, reason: 'limit_reached', max_per_turn: PROGRESS_NOTE_MAX_PER_TURN }));
      const waitMs = slot.lastAt + PROGRESS_NOTE_MIN_GAP_MS - started;
      if (waitMs > 0) return done(unsent({ sent: false, reason: 'too_soon', wait_seconds: Math.ceil(waitMs / 1_000) }));
      // The same link guards the final reply gets: no sign-in or connect URL, and no artifact link without a receipt.
      const text = guardArtifactLinks(redactSecretUrls(args.text).text, new Set());
      let delivered: boolean;
      try {
        ctx.runScope?.admit();
        delivered = await deps.deliver(text, turn);
      } catch (error) {
        if (error instanceof ClosedRunError) throw error;
        // A send that threw may still have reached the owner, so it spends the allowance; the model hears only the reason.
        slot.count += 1; slot.lastAt = started;
        return done(unsent({ sent: false, reason: 'send_failed' }));
      }
      if (!delivered) return done(unsent({ sent: false, reason: 'send_failed' }));
      slot.count += 1; slot.lastAt = started;
      return done({ ok: true, data: { sent: true, notes_left: PROGRESS_NOTE_MAX_PER_TURN - slot.count }, source_taint: null });
    },
  };
};
