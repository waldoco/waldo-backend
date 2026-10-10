import type { HealthSource } from '@waldo/contracts';
import { healthDaySchema, healthTimezoneSchema } from '../../../contracts/src/health/ingest';
import { healthDemandObservationSchema, type HealthDemandObservation } from '../../../contracts/src/health/demand';
import type { GoogleClient } from '../connectors/google';
import type { HealthDemandProduction } from './demand';
import type { HealthClock, HealthProduction, HealthResult } from './production';
import type { HealthSupplementalInputs } from './producer';
import type { CandidateSeries } from './calculations';

export type HealthDemandAccount = Readonly<{
  id: string; revision: string; calendar_ids: readonly string[]; task_list_ids: readonly string[];
}>;
export type HealthOwnerEstimate = Readonly<{
  account_ref: string | null; task_list_ref: string | null; task_ref: string;
  due_day: string; minutes: number; evidence_ref: string;
}>;
export type HealthResponseObligation = Readonly<{
  id: string; account_ref: string | null; revision: number;
  state: 'requires_owner_response' | 'resolved' | 'unknown'; evidence_ref: string;
}>;
export type HealthDemandCollectorHost = Readonly<{
  owner_ref: string;
  health: HealthProduction;
  demand: HealthDemandProduction;
  // This is the authenticated owner/source fence, including current account grants.
  assertCurrent(): Promise<void>;
  accounts(): Promise<readonly HealthDemandAccount[]>;
  google(account: HealthDemandAccount): Promise<GoogleClient>;
  // Estimates are explicit owner-confirmed facts, never parsed from Google notes.
  ownerEstimates(): Promise<Readonly<{ complete: boolean; estimates: readonly HealthOwnerEstimate[] }>>;
  // The existing responsibility brain supplies these states. This collector never
  // classifies mail or substitutes unread counts for response obligations.
  responses(): Promise<Readonly<{ complete: boolean; account_refs: readonly string[]; obligations: readonly HealthResponseObligation[] }>>;
}>;
export type HealthDemandCapture = Readonly<{
  source: HealthSource; consent_epoch: number; day: string; timezone: string; as_of: string;
}>;
type DemandScope = Readonly<{ metric: HealthDemandObservation['metric']; source_ref: string; context_ref: string }>;

const localParts = (at: number, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  const part = (key: string) => parts.find(value => value.type === key)!.value;
  return { day: `${part('year')}-${part('month')}-${part('day')}`, minute: `${part('hour')}${part('minute')}` };
};
// Find the actual first instant in each local date, rather than assuming a day is
// 24 hours. The bounds therefore preserve all-day/free-busy and DST semantics.
export const healthDemandDayBounds = (day: string, timezone: string): Readonly<{ from: string; to: string }> => {
  if (!healthDaySchema.safeParse(day).success || !healthTimezoneSchema.safeParse(timezone).success) throw new Error('invalid demand date');
  const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
  const first = (target: string) => {
    let lo = Date.parse(target) - 48 * 3600000, hi = Date.parse(target) + 48 * 3600000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (localParts(mid, timezone).day < target) lo = mid; else hi = mid;
    }
    if (localParts(hi, timezone).day !== target) throw new Error('local demand date absent');
    return hi;
  };
  return { from: new Date(first(day)).toISOString(), to: new Date(first(next)).toISOString() };
};
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
const accountShape = (accounts: readonly HealthDemandAccount[]) => accounts.map(account => ({ ...account, calendar_ids: [...account.calendar_ids].sort(), task_list_ids: [...account.task_list_ids].sort() })).sort((a, b) => a.id.localeCompare(b.id));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unionMinutes = (intervals: readonly Readonly<{ start: string; end: string }>[], from: string, to: string): number => {
  const bounds = [Date.parse(from), Date.parse(to)] as const;
  const rows = intervals.map(row => [Math.max(bounds[0], Date.parse(row.start)), Math.min(bounds[1], Date.parse(row.end))] as const).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
  let total = 0, start = 0, end = 0;
  for (const [a, b] of rows) {
    if (!end) { start = a; end = b; }
    else if (a <= end) end = Math.max(end, b);
    else { total += end - start; start = a; end = b; }
  }
  return (total + (end ? end - start : 0)) / 60000;
};

// Source-backed demand stays in the health Supabase plane. No numeric payload is
// stored in the owner DO, the ordinary tool ledger, a transcript or an observer.
export const createHealthDemandCollector = (host: HealthDemandCollectorHost, clock: HealthClock = { now: () => new Date() }) => {
  const fenced = async <T>(read: () => Promise<T>): Promise<T> => {
    await host.assertCurrent(); const value = await read(); await host.assertCurrent(); return value;
  };
  const consent = async (input: HealthDemandCapture) => {
    const state = await fenced(() => host.health.consents());
    return state.ok && state.data.consents.some(row => row.source === input.source && row.purpose === 'storage_compute' && row.status === 'granted' && row.epoch === input.consent_epoch);
  };
  const accountSnapshot = async () => {
    const accounts = accountShape(await fenced(host.accounts));
    if (accounts.length > 32 || new Set(accounts.map(account => account.id)).size !== accounts.length || accounts.some(account => !uuid.test(account.id) || !account.revision || account.calendar_ids.length > 50 || account.task_list_ids.length > 128 || new Set(account.calendar_ids).size !== account.calendar_ids.length || new Set(account.task_list_ids).size !== account.task_list_ids.length)) throw new Error('invalid demand scope');
    return { accounts, accountDigest: await digest(accounts) };
  };
  const contextFor = (input: HealthDemandCapture) => `day-demand.v1.${input.timezone.replace(/[^A-Za-z0-9._:-]/g, '_')}.${localParts(Date.parse(input.as_of), input.timezone).minute}`;
  const scopesFor = (accounts: readonly HealthDemandAccount[], accountDigest: string, context_ref: string): DemandScope[] => [
    ...(accounts.some(account => account.calendar_ids.length) ? [{ metric: 'calendar_minutes' as const, source_ref: `google-calendar.${accountDigest}`, context_ref }] : []),
    { metric: 'task_minutes', source_ref: `owner-tasks.${accountDigest}`, context_ref },
    { metric: 'message_count', source_ref: `owner-responses.${accountDigest}`, context_ref },
  ];
  const validCapture = (input: HealthDemandCapture) => host.owner_ref && Number.isSafeInteger(input.consent_epoch) && input.consent_epoch > 0 && Number.isFinite(Date.parse(input.as_of)) && healthDaySchema.safeParse(input.day).success && healthTimezoneSchema.safeParse(input.timezone).success && localParts(Date.parse(input.as_of), input.timezone).day === input.day;
  const currentCapture = (input: HealthDemandCapture) => Math.abs(clock.now().getTime() - Date.parse(input.as_of)) <= 300000 && localParts(clock.now().getTime(), input.timezone).day === input.day;
  const capture = async (input: HealthDemandCapture): Promise<HealthResult<Readonly<{ scopes: readonly DemandScope[] }>>> => {
    const asOf = Date.parse(input.as_of);
    // Current provider state cannot be backdated into an invented historical observation.
    if (!validCapture(input) || !currentCapture(input)) return { ok: false, error: 'invalid_request' };
    try {
      if (!await consent(input)) return { ok: false, error: 'consent_required' };
      const { accounts, accountDigest } = await accountSnapshot();
      const context = contextFor(input);
      const bounds = healthDemandDayBounds(input.day, input.timezone);
      const estimates = await fenced(host.ownerEstimates), responses = await fenced(host.responses);
      const revision = asOf;
      const base = { day: input.day, timezone: input.timezone, observed_at: input.as_of, queried_at: input.as_of, revision, context_ref: context, evidence_ref: `demand-query.${accountDigest.slice(0, 24)}.${revision}`, query_complete: true, missing_reason: null };
      const intervals: { start: string; end: string }[] = [], tasks: { account: string; list: string; id: string; due: string }[] = [];
      let calendarComplete = true, taskComplete = estimates.complete;
      const calendarAccounts = accounts.filter(account => account.calendar_ids.length), taskAccounts = accounts.filter(account => account.task_list_ids.length);
      for (const account of accounts) {
        const google = await fenced(() => host.google(account));
        if (account.calendar_ids.length) {
          try {
            const result = await fenced(() => google.freeBusy(bounds.from, bounds.to, account.calendar_ids, input.timezone));
            if (Date.parse(result.from) !== Date.parse(bounds.from) || Date.parse(result.to) !== Date.parse(bounds.to) || Object.keys(result.calendars).some(id => !account.calendar_ids.includes(id))) calendarComplete = false;
            for (const id of account.calendar_ids) {
              const calendar = result.calendars[id];
              if (!calendar || calendar.errors?.length || calendar.busy.some(row => !Number.isFinite(Date.parse(row.start)) || !Number.isFinite(Date.parse(row.end)) || Date.parse(row.start) >= Date.parse(row.end))) calendarComplete = false;
              else intervals.push(...calendar.busy);
            }
          } catch { await host.assertCurrent(); calendarComplete = false; }
        }
        for (const list of account.task_list_ids) {
          if (!google.tasksPage) { taskComplete = false; break; }
          let token: string | undefined, pages = 0; const seen = new Set<string>(), taskIds = new Set<string>();
          do {
            try {
              const page = await fenced(() => google.tasksPage!(list, 'todo', 100, token));
              if (page.account.connection_id !== account.id || page.fetched_count < page.tasks.length || !page.task_list_ids.includes(list) || page.task_list_ids.some(id => id !== list)) { taskComplete = false; break; }
              for (const task of page.tasks) {
                if (task.task_list_id !== list || taskIds.has(task.id)) { taskComplete = false; continue; }
                taskIds.add(task.id);
                if (task.status === 'todo' && task.due?.slice(0, 10) === input.day) tasks.push({ account: account.id, list, id: task.id, due: input.day });
              }
              token = page.next_page_token ?? undefined;
              if (token && (seen.has(token) || ++pages >= 64)) { taskComplete = false; break; }
              if (token) seen.add(token);
            } catch { await host.assertCurrent(); taskComplete = false; break; }
          } while (token);
        }
      }
      const taskEstimates = tasks.map(task => estimates.estimates.filter(estimate => estimate.account_ref === task.account && estimate.task_list_ref === task.list && estimate.task_ref === task.id && estimate.due_day === input.day));
      const ownerTasks = estimates.estimates.filter(estimate => estimate.account_ref === null && estimate.task_list_ref === null && estimate.due_day === input.day);
      if (taskEstimates.some(matches => matches.length !== 1) || [...taskEstimates.flat(), ...ownerTasks].some(estimate => !Number.isFinite(estimate.minutes) || estimate.minutes <= 0 || !estimate.evidence_ref) || new Set(ownerTasks.map(estimate => estimate.task_ref)).size !== ownerTasks.length) taskComplete = false;
      const scopedResponses = responses.obligations.filter(row => row.account_ref === null || accounts.some(account => account.id === row.account_ref));
      const responseComplete = responses.complete && responses.account_refs.every(id => accounts.some(account => account.id === id)) && new Set(responses.account_refs).size === responses.account_refs.length && scopedResponses.length === responses.obligations.length && new Set(scopedResponses.map(row => row.id)).size === scopedResponses.length && scopedResponses.every(row => row.state !== 'unknown' && (row.account_ref === null || responses.account_refs.includes(row.account_ref)) && Number.isSafeInteger(row.revision) && row.revision >= 0 && row.evidence_ref);
      const taskValue = taskComplete ? [...taskEstimates.flat(), ...ownerTasks].reduce((sum, estimate) => sum + estimate.minutes, 0) : null;
      const rows: HealthDemandObservation[] = [
        ...(calendarAccounts.length ? [healthDemandObservationSchema.parse({ ...base, metric: 'calendar_minutes', source_ref: `google-calendar.${accountDigest}`, unit: 'minutes', method: 'union_busy_minutes', supplier: 'google_calendar', connection_refs: calendarAccounts.map(account => account.id), query_complete: calendarComplete, missing_reason: calendarComplete ? null : 'incomplete_query', value: calendarComplete ? unionMinutes(intervals, bounds.from, bounds.to) : null })] : []),
        healthDemandObservationSchema.parse({ ...base, metric: 'task_minutes', source_ref: `owner-tasks.${accountDigest}`, unit: 'minutes', method: 'owner_estimated_due_minutes', supplier: taskAccounts.length ? 'google_tasks' : 'owner_work', connection_refs: taskAccounts.map(account => account.id), estimate_refs: [...taskEstimates.flat(), ...ownerTasks].map(estimate => estimate.evidence_ref), query_complete: taskComplete, missing_reason: taskComplete ? null : 'missing_owner_estimates', value: taskValue }),
        healthDemandObservationSchema.parse({ ...base, metric: 'message_count', source_ref: `owner-responses.${accountDigest}`, unit: 'count', method: 'requires_owner_response_count', supplier: 'responsibilities', connection_refs: responses.account_refs, query_complete: responseComplete, missing_reason: responseComplete ? null : 'unknown_responsibility_state', value: responseComplete ? scopedResponses.filter(row => row.state === 'requires_owner_response').length : null }),
      ];
      // A disconnect/grant change during any earlier await cannot produce a durable
      // snapshot or return a previously admitted baseline.
      if (await digest(accountShape(await fenced(host.accounts))) !== accountDigest || !await consent(input)) return { ok: false, error: 'epoch_conflict' };
      const requestId = `demand_${(await digest([host.owner_ref, input, rows])).slice(0, 56)}`;
      const written = await fenced(() => host.demand.record({ request_id: requestId, source: input.source, consent_epoch: input.consent_epoch, observations: rows }));
      if (!written.ok) return written;
      if ((await accountSnapshot()).accountDigest !== accountDigest) return { ok: false, error: 'epoch_conflict' };
      if (!await consent(input)) return { ok: false, error: 'consent_withdrawn' };
      await host.assertCurrent();
      return { ok: true, data: { scopes: rows.map(row => ({ metric: row.metric, source_ref: row.source_ref, context_ref: row.context_ref })) } };
    } catch { return { ok: false, error: 'unavailable' }; } // No physiological/provider payloads in error text.
  };
  return {
    capture,
    async supplemental(input: HealthDemandCapture & Readonly<{ owner_ref: string; physical_load: CandidateSeries }>): Promise<HealthSupplementalInputs> {
      if (input.owner_ref !== host.owner_ref || !validCapture(input)) return {};
      try {
        if (!await consent(input)) return {};
        const snapshot = await accountSnapshot();
        // Historical views consume existing consented snapshots. They never query
        // today's Tasks or responsibility states and assign them a past date.
        let scopes = scopesFor(snapshot.accounts, snapshot.accountDigest, contextFor(input));
        if (currentCapture(input)) {
          const recorded = await capture(input);
          if (!recorded.ok) return {};
          scopes = [...recorded.data.scopes];
        }
        const series = async (metric: HealthDemandObservation['metric']): Promise<CandidateSeries | null> => {
          const scope = scopes.find(row => row.metric === metric);
          if (!scope) return null;
          const read = await fenced(() => host.demand.series({ ...scope, source: input.source, consent_epoch: input.consent_epoch, day: input.day, timezone: input.timezone }));
          return read.ok ? read.data : null;
        };
        const calendar = await series('calendar_minutes'), tasks = await series('task_minutes'), messages = await series('message_count');
        // A disconnect or grant change during any read cannot release old numbers.
        if ((await accountSnapshot()).accountDigest !== snapshot.accountDigest || !await consent(input)) return {};
        await host.assertCurrent();
        return { weight: { calendar, tasks, messages, physical_load: input.physical_load } };
      } catch { return {}; } // Unavailable inputs never become numeric zero.

    },
  };
};
