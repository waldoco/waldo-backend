import { EffectNotAppliedError, type EffectReadback, type EffectReceipt } from './owner-effect-ledger';
import { localIso, localToEpoch } from './reminders';
import { GoogleError, sha256Hex, type GoogleClient } from '../connectors/google';

// A day plan (approvals revision 9): new blocks on the owner's own primary calendar, added by one approval. The model only
// proposes; the owner's tap adds them. Done means every block landed. A block added before another failed is removed again
// before the card reads not done, and a block that cannot be shown removed leaves the card's outcome unknown, naming it.
export type PlanBlock = Readonly<{ title: string; start: string; end: string; block?: 'rest' | 'deep_work' }>;
export type StoredPlan = Readonly<{ account?: string; day: string; time_zone: string; blocks: readonly PlanBlock[]; reason: string; operation_ref?: string }>;
// applied_etag: the version this plan wrote, the only one Undo may remove; null for a block whose add was proven only by
// readback, which a later owner edit could share, so Undo leaves it.
export type PlanUndo = Readonly<{ op: 'plan'; blocks: readonly Readonly<{ id: string; title: string; applied_etag: string | null }>[]; until?: number }>;
export type PlanOutcome =
  | Readonly<{ state: 'done'; undo: PlanUndo }>
  | Readonly<{ state: 'not_done'; removed: number }>
  // left: the titles that may still be on the owner's calendar.
  | Readonly<{ state: 'unknown'; left: readonly string[] }>;
type Effect = (operationId: string, tool: string, payload: unknown, dispatch: () => Promise<EffectReceipt>, reconcile: () => Promise<EffectReadback>) => Promise<EffectReceipt>;

// An instant in the owner's zone, written with its own offset, as Google and the app contract read it.
export const offsetIso = (at: number, timezone: string): string => {
  const local = localIso(at, timezone), minutes = Math.round((Date.parse(`${local}:00Z`) - at) / 60_000);
  const sign = minutes < 0 ? '-' : '+', abs = Math.abs(minutes);
  return `${local}:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};

// The model's local times on the owner's day, as instants. A time the clocks skip that day is refused, never moved; a time they
// repeat takes its later occurrence. A plan that then breaks order is refused with the reason.
export const planBlocks = (input: Readonly<{ day: string; blocks: readonly Readonly<{ title: string; start: string; end: string; block?: 'rest' | 'deep_work' }>[] }>, timezone: string): readonly PlanBlock[] | string => {
  const at = (time: string) => offsetIso(localToEpoch(`${input.day}T${time}`, timezone), timezone);
  const skipped = input.blocks.flatMap(({ start, end }) => [start, end]).find(time => at(time).slice(0, 16) !== `${input.day}T${time}`);
  if (skipped !== undefined) return `${skipped} does not exist on ${input.day}, when the clocks change`;
  const blocks = input.blocks.map(({ title, start, end, block }) => ({ title, start: at(start), end: at(end), ...(block ? { block } : {}) }));
  if (blocks.some(({ start, end }) => !(Date.parse(start) < Date.parse(end)))) return 'each block must end after it starts';
  if (blocks.some((block, index) => index > 0 && Date.parse(blocks[index - 1]!.end) > Date.parse(block.start))) return 'blocks must run in order without overlapping';
  if (blocks.some(({ start }) => start.slice(0, 10) !== input.day)) return "every block must start on the plan's day";
  return blocks;
};

const clock = (iso: string) => iso.slice(11, 16);
const KIND: Readonly<Record<NonNullable<PlanBlock['block']>, string>> = { rest: ' (rest)', deep_work: ' (deep work)' };
// The card's words: the day, then each block at its own time. The same text reads true before the owner decides and after.
export const planReview = (plan: StoredPlan): string => {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${plan.day}T12:00:00Z`));
  return [`Add ${plan.blocks.length} blocks to your calendar${plan.account ? ` (${plan.account})` : ''} on ${day}:`,
    ...plan.blocks.map(block => `${clock(block.start)}–${clock(block.end)} ${block.title}${block.block ? KIND[block.block] : ''}`),
    '', `No one is invited. ${plan.reason}`].join('\n');
};

const gone = (error: unknown) => error instanceof GoogleError && (error.status === 404 || error.status === 410);
// A call Google answered by refusing it (expired or revoked access, a bad request) wrote nothing.
const refused = (error: unknown) => error instanceof GoogleError && [400, 401, 403].includes(error.status);
const removed = async (client: GoogleClient, id: string, marker: string): Promise<EffectReadback> => {
  try {
    const current = await client.event(id);
    return current.status === 'cancelled' && current.operation_marker === marker ? { status: 'done', receipt: { provider_id: id, result: 'removed' } } : { status: 'unknown' };
  } catch (error) { return gone(error) ? { status: 'done', receipt: { provider_id: id, result: 'absent' } } : { status: 'unknown' }; }
};

// Every block, each its own effect with a fixed event id and marker, so a replay after an interruption adds nothing twice and
// a readback finds what an interrupted add did. With `made`, each block carries Waldo's mark (standing grants are on).
export const addPlan = async (input: Readonly<{ client: GoogleClient; effect: Effect; operationRef: string; plan: StoredPlan; made: boolean }>): Promise<PlanOutcome> => {
  const { client, effect, operationRef, plan } = input;
  const added: { index: number; id: string; title: string; applied_etag: string | null }[] = [];
  let failed: Readonly<{ index: number; maybe: boolean }> | null = null;
  for (const [index, block] of plan.blocks.entries()) {
    const operationId = `${operationRef}:apply:${index}`, id = await sha256Hex(operationId);
    try {
      const receipt = await effect(operationId, 'calendar_plan', { ...block, block_index: index }, async () => {
        try {
          const event = await client.createEvent({ title: block.title, start: block.start, end: block.end, id, operationMarker: id, ...(block.block ? { block: block.block } : {}), ...(input.made ? { made: true } : {}) });
          return { provider_id: id, result: { etag: event.etag ?? null } };
        } catch (error) { throw refused(error) ? new EffectNotAppliedError() : error; }
      }, async () => {
        try {
          const current = await client.event(id);
          return current.operation_marker === id && current.status !== 'cancelled' ? { status: 'done', receipt: { provider_id: id, result: { etag: null } } } : { status: 'unknown' };
        } catch (error) { return gone(error) || refused(error) ? { status: 'not_applied' } : { status: 'unknown' }; }
      });
      added.push({ index, id, title: block.title, applied_etag: (receipt.result as { etag?: string | null } | null)?.etag ?? null });
    } catch (error) {
      failed = { index, maybe: !(error instanceof EffectNotAppliedError) };
      break;
    }
  }
  if (failed === null) return { state: 'done', undo: { op: 'plan', blocks: added.map(({ id, title, applied_etag }) => ({ id, title, applied_etag })) } };
  // All or nothing: what was added, and the block whose add may have landed, are removed again.
  const targets = [...added, ...(failed.maybe ? [{ index: failed.index, id: await sha256Hex(`${operationRef}:apply:${failed.index}`), title: plan.blocks[failed.index]!.title }] : [])];
  const left: string[] = [];
  for (const target of targets) {
    const operationId = `${operationRef}:rollback:${target.index}`, marker = await sha256Hex(operationId);
    try {
      await effect(operationId, 'calendar_plan_rollback', { id: target.id }, async () => {
        let current;
        try { current = await client.event(target.id); } catch (error) { if (gone(error)) return { provider_id: target.id, result: 'absent' }; throw refused(error) ? new EffectNotAppliedError() : error; }
        if (current.status === 'cancelled') return { provider_id: target.id, result: 'absent' };
        try { await client.cancelEvent(target.id, current.etag, marker); } catch (error) { throw refused(error) ? new EffectNotAppliedError() : error; }
        return { provider_id: target.id, result: 'removed' };
      }, () => removed(client, target.id, marker));
    } catch { left.push(target.title); }
  }
  return left.length ? { state: 'unknown', left } : { state: 'not_done', removed: added.length };
};

// Once a removal began (a rollback, or an undo), the plan is never added again: a cached add would read as landed after its
// block was removed. What is on the calendar is read back instead, by each block's fixed event id. `unread`: a read that failed.
export const planOnCalendar = async (client: GoogleClient, operationRef: string, plan: StoredPlan): Promise<Readonly<{ present: readonly string[]; unread: readonly string[] }>> => {
  const present: string[] = [], unread: string[] = [];
  for (const [index, block] of plan.blocks.entries()) {
    try { if ((await client.event(await sha256Hex(`${operationRef}:apply:${index}`))).status !== 'cancelled') present.push(block.title); }
    catch (error) { if (!gone(error)) unread.push(block.title); }
  }
  return { present, unread };
};

// Undo: each block the plan added is removed while it is still the version the plan wrote. One the owner changed since, or
// whose version is not known, is left as it is.
export type PlanRemoval = Readonly<{ removed: readonly string[]; kept: readonly string[]; unknown: readonly string[] }>;
export const undoPlan = async (input: Readonly<{ client: GoogleClient; effect: Effect; operationRef: string; undo: PlanUndo }>): Promise<PlanRemoval> => {
  const { client, effect, operationRef, undo } = input;
  const out = { removed: [] as string[], kept: [] as string[], unknown: [] as string[] };
  for (const [index, block] of undo.blocks.entries()) {
    const operationId = `${operationRef}:undo:${index}`, marker = await sha256Hex(operationId);
    try {
      const receipt = await effect(operationId, 'calendar_plan_undo', { id: block.id, applied_etag: block.applied_etag }, async () => {
        let current;
        try { current = await client.event(block.id); } catch (error) { if (gone(error)) return { provider_id: block.id, result: 'absent' }; throw refused(error) ? new EffectNotAppliedError() : error; }
        if (current.status === 'cancelled') return { provider_id: block.id, result: 'absent' };
        if (block.applied_etag === null || current.etag !== block.applied_etag) return { provider_id: block.id, result: 'kept' };
        try { await client.cancelEvent(block.id, block.applied_etag, marker); } catch (error) {
          if (error instanceof GoogleError && error.status === 412) return { provider_id: block.id, result: 'kept' };
          throw refused(error) ? new EffectNotAppliedError() : error;
        }
        return { provider_id: block.id, result: 'removed' };
      }, () => removed(client, block.id, marker));
      (receipt.result === 'kept' ? out.kept : out.removed).push(block.title);
    } catch (error) { (error instanceof EffectNotAppliedError ? out.kept : out.unknown).push(block.title); }
  }
  return out;
};
