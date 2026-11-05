import { runOriginSchema, standingGrantRecordSchema, type RunOrigin, type StandingGrantRecord } from '@waldo/contracts';
import { appAutonomyGrantTermsV1Schema, type AppAutonomyGrantTermsV1, type AutonomyClassV1 } from '../../../contracts/src/app/autonomy';
import type { SurfaceNameV1 } from '../../../contracts/src/app/surfaces';
import type { GrantUsageKey } from './owner-effect-ledger';

// The owner's standing grants and the one pause: the only authority that lets an effect run without a card. This module is
// their only writer. It enforces authority bounds only (owner, class, resource, window, lead, count, expiry, revision,
// origin, pause); whether an action serves the grant is the model's judgment, and nothing here reads titles or text.
const GRANT = 'autonomy:grant:';
const PAUSED = 'autonomy:paused';
// A calendar change as the desk stores it, with what it read of the event before a move or a cancel: its time, its guests,
// whether it is part of a series, and whether it carries the private mark Waldo writes on the events it creates.
export type OwnBlockChange = Readonly<{
  action: 'create' | 'move' | 'cancel'; account?: string; calendar_id?: string; event_id?: string | null; start?: string | null; end?: string | null;
  attendees?: readonly string[]; send_updates?: 'all' | 'none'; rename_to?: string; location?: string; description?: string; add_meet_link?: boolean;
  seen_start?: string; seen_end?: string; seen_guests?: number; seen_recurring?: boolean; seen_made?: boolean;
}>;
// Closed, for traces: never a title, an id, a time or an address.
export type GrantRefusal = 'off' | 'paused' | 'origin' | 'no_grant' | 'not_primary' | 'not_waldo_made' | 'shape' | 'outside_bounds' | 'lead';
export type GrantUse = Readonly<{
  grant_id: string; revision: number; class: AutonomyClassV1;
  quota: GrantUsageKey & Readonly<{ max_per_day: number }>;
  // Rechecked inside the effect ledger's reserve: the switch, the pause, this revision still current, its time, and the lead.
  authorize(): boolean;
}>;
export type GrantDecision = Readonly<{ use: GrantUse }> | Readonly<{ refused: GrantRefusal }>;

// Waldo's own guest-free blocks touch no one, are capped and undoable, so Waldo's own runs may use them as the owner's turns
// do. A run woken by or replying to someone else's words never does, and neither does one with no origin (a health trigger).
const OWN_BLOCK_ORIGINS: readonly RunOrigin[] = ['owner', 'owner_standing', 'waldo'];
// The account's primary calendar: named by default, as 'primary', or by the account's own address.
const onPrimary = (calendarId: string | undefined, account: string) =>
  calendarId === undefined || calendarId === 'primary' || calendarId.toLowerCase() === account.toLowerCase();

// The resource a grant is bound to, so a second grant for the same class and resource supersedes the first instead of sitting
// beside it, and the day's budget is kept per resource whichever grant uses it.
const resourceOf = (terms: AppAutonomyGrantTermsV1) => terms.scope.class === 'calendar.move_own_block' ? `${terms.scope.class}:${terms.scope.account.toLowerCase()}` : terms.scope.class;
// The classes this server can run. Every other class reads not_yet, and nothing writes a grant for it.
export const AVAILABLE_CLASSES: readonly AutonomyClassV1[] = ['calendar.move_own_block'];
// The contract shows at most this many grants of one class.
export const GRANTS_PER_CLASS_MAX = 10;
export class GrantLimitError extends Error {
  constructor() { super(`at most ${GRANTS_PER_CLASS_MAX} grants of one kind`); }
}

const localParts = (ms: number, timeZone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!) };
};

export const standingGrants = (storage: DurableObjectStorage, deps: Readonly<{
  now(): number; newId(): string;
  // The deployment switch; off, nothing authorizes and every proposal cards.
  enabled(): boolean;
  ownerRef(): string;
}>) => {
  const read = (grantId: string): StandingGrantRecord | null => {
    const parsed = standingGrantRecordSchema.safeParse(storage.kv.get(GRANT + grantId));
    return parsed.success ? parsed.data : null;
  };
  const paused = () => storage.kv.get<Readonly<{ at: number; via: SurfaceNameV1 }>>(PAUSED) ?? null;
  const holds = (grant: StandingGrantRecord, now: number) => grant.ended === null && grant.terms.valid_from <= now && now < grant.terms.expires_at;
  const list = () => [...storage.kv.list({ prefix: GRANT })].map(([key]) => read(key.slice(GRANT.length))).filter(grant => grant !== null);
  const write = (grant: StandingGrantRecord) => { storage.kv.put(GRANT + grant.grant_id, standingGrantRecordSchema.parse(grant)); return grant; };
  const active = (now = deps.now()) => list().filter(grant => holds(grant, now));
  // Not ended and not past its end, whether or not it has started.
  const standing = (now = deps.now()) => list().filter(grant => grant.ended === null && now < grant.terms.expires_at);
  // How the day's uses of a grant are counted in the effect ledger: by class and resource on the owner's local day.
  const usage = (grant: StandingGrantRecord, now: number) => ({ owner_ref: deps.ownerRef(), grant_ref: resourceOf(grant.terms), area: 'calendar', action: 'own_block',
    local_day: localParts(now, grant.terms.limits.timezone).day, timezone: grant.terms.limits.timezone });

  const ownBlock = (change: OwnBlockChange, origin: RunOrigin | undefined): GrantDecision => {
    if (!deps.enabled()) return { refused: 'off' };
    if (paused()) return { refused: 'paused' };
    if (origin === undefined || !runOriginSchema.safeParse(origin).success || !OWN_BLOCK_ORIGINS.includes(origin)) return { refused: 'origin' };
    const now = deps.now();
    const grant = list().find(candidate => candidate.terms.scope.class === 'calendar.move_own_block' && holds(candidate, now)
      && candidate.terms.scope.account.toLowerCase() === change.account?.toLowerCase());
    if (!grant || grant.terms.scope.class !== 'calendar.move_own_block') return { refused: 'no_grant' };
    if (!onPrimary(change.calendar_id, grant.terms.scope.account)) return { refused: 'not_primary' };
    // A create is Waldo's by making it; a move or a cancel only of an event read back carrying Waldo's mark.
    if (change.action !== 'create' && change.seen_made !== true) return { refused: 'not_waldo_made' };
    // Only a time: nothing that notifies, invites, renames or carries details, and nothing with guests or in a series.
    if (change.attendees?.length || change.send_updates || change.rename_to !== undefined || change.location !== undefined || change.description !== undefined
      || change.add_meet_link || change.seen_recurring || change.seen_guests) return { refused: 'shape' };
    const { window, weekdays, min_lead_minutes } = grant.terms.scope;
    const { timezone, max_per_day } = grant.terms.limits;
    // A cancel is bounded by where the block is now; a create or a move by where it goes, and a move by where it was too.
    const start = Date.parse((change.action === 'cancel' ? change.seen_start : change.start) ?? ''), end = Date.parse((change.action === 'cancel' ? change.seen_end : change.end) ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { refused: 'outside_bounds' };
    const from = localParts(start, timezone), to = localParts(end, timezone);
    if (from.day !== to.day || !weekdays.includes(from.weekday) || from.time < window.from || to.time > window.to) return { refused: 'outside_bounds' };
    const lead = min_lead_minutes * 60_000;
    const seen = change.seen_start === undefined ? null : Date.parse(change.seen_start);
    const ahead = (at: number) => start - at >= lead && (seen === null || seen - at >= lead);
    if (!ahead(now)) return { refused: 'lead' };
    const { grant_id, revision } = grant;
    return { use: {
      grant_id, revision, class: 'calendar.move_own_block',
      // Keyed by class and resource, never by grant id, so a changed or re-made grant cannot reset the day's count.
      quota: { ...usage(grant, now), max_per_day },
      authorize: () => {
        const current = read(grant_id), at = deps.now();
        return deps.enabled() && paused() === null && current !== null && current.revision === revision && holds(current, at) && ahead(at);
      },
    } };
  };

  return {
    // Whether Waldo marks the events it creates as its own, which only matters while grants can act.
    enabled: deps.enabled,
    list,
    active,
    paused,
    usage,
    ownBlock,
    // A grant for a class and resource that already holds one supersedes it: the same id at the next revision, so anything
    // evaluated against the old terms is refused at dispatch and the day's count carries over.
    grant(terms: AppAutonomyGrantTermsV1, via: SurfaceNameV1): StandingGrantRecord {
      const parsed = appAutonomyGrantTermsV1Schema.parse(terms);
      if (!AVAILABLE_CLASSES.includes(parsed.scope.class)) throw new Error('that class cannot be granted yet');
      return storage.transactionSync(() => {
        const held = standing().filter(grant => grant.terms.scope.class === parsed.scope.class);
        const current = held.find(grant => resourceOf(grant.terms) === resourceOf(parsed));
        if (current) return write({ ...current, revision: current.revision + 1, terms: parsed, created_via: via });
        if (held.length >= GRANTS_PER_CLASS_MAX) throw new GrantLimitError();
        return write({ grant_id: deps.newId(), revision: 1, terms: parsed, created_at: deps.now(), created_via: via, ended: null });
      });
    },
    // A wider or renewed grant keeps its id and raises its revision, so anything evaluated against the old terms is refused.
    change(grantId: string, terms: AppAutonomyGrantTermsV1): StandingGrantRecord {
      return storage.transactionSync(() => {
        const current = read(grantId);
        if (!current || current.ended) throw new Error('that grant has ended or does not exist');
        return write({ ...current, revision: current.revision + 1, terms: appAutonomyGrantTermsV1Schema.parse(terms) });
      });
    },
    // Narrowing authority always applies, with no card and no reviewed revision.
    revoke(grantId: string): boolean {
      return storage.transactionSync(() => {
        const current = read(grantId);
        if (!current || current.ended) return false;
        write({ ...current, ended: { at: deps.now(), reason: 'revoked' } });
        return true;
      });
    },
    // Ends every grant of a class still running, for "stop doing that on your own".
    revokeClass(cls: AutonomyClassV1): number {
      return storage.transactionSync(() => {
        const ending = list().filter(grant => grant.ended === null && grant.terms.scope.class === cls && deps.now() < grant.terms.expires_at);
        for (const grant of ending) write({ ...grant, ended: { at: deps.now(), reason: 'revoked' } });
        return ending.length;
      });
    },
    pause(via: SurfaceNameV1): void { if (!paused()) storage.kv.put(PAUSED, { at: deps.now(), via }); },
    resume(): void { storage.kv.delete(PAUSED); },
  };
};
export type StandingGrants = ReturnType<typeof standingGrants>;
