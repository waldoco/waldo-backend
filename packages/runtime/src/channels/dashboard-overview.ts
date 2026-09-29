import type { ApprovalItem } from './approvals';
import type { BackgroundRun } from './background-runs';
import { localIso, localToEpoch } from './reminders';

export const DASHBOARD_OVERVIEW_PATH = '/console/dashboard/api/v1/overview';
export const DASHBOARD_OVERVIEW_HEADERS = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
} as const;

type Plan = Readonly<{ card: string; time: string | null; reason: string; sent: boolean }>;
type Card = Readonly<{ id: string; name: string }>;
type Grant = Readonly<{ id: string; email: string; error: string | null; calendar: boolean; mail: boolean; tasks: boolean }>;
type Trace = Readonly<{ at: number; hop: string; ok: boolean }>;

// Projection from owner-DO state only. In particular, never recycle ConsoleView: it contains
// CSRF, memory, other private data and a paginated (not newest) activity slice.
export const dashboardOverview = (input: Readonly<{
  now: number; timezone: string; plans: readonly Plan[]; cards: readonly Card[];
  approvals: readonly ApprovalItem[]; run: BackgroundRun | null; trace: Trace | null;
  grants: readonly Grant[];
}>) => {
  const { now, timezone } = input;
  const planned = new Map(input.plans.map((row) => [row.card, row]));
  const brief = planned.get('card:brief');
  const waiting = input.approvals.filter((item) => ['open', 'review_only', 'unconfirmed'].includes(item.state));
  const next = input.cards.flatMap((card) => {
    const row = planned.get(card.id);
    if (!row || row.sent || row.time === null) return [];
    const at = localToEpoch(`${localIso(now, timezone).slice(0, 10)}T${row.time}`, timezone);
    return at > now ? [{ id: card.id, label: card.name, scheduled_at: new Date(at).toISOString(), epoch: at }] : [];
  }).sort((a, b) => a.epoch - b.epoch)[0];
  const run = input.run;
  const trace = input.trace;
  const runAt = run?.ended_at ?? run?.started_at ?? 0;
  const activity = run && (!trace || runAt >= trace.at)
    ? { kind: run.kind, status: run.status, at: new Date(runAt).toISOString(), summary: run.summary }
    : trace ? { kind: trace.hop, status: trace.ok ? 'completed' : 'failed', at: new Date(trace.at).toISOString(), summary: null } : null;
  return {
    version: 1 as const,
    as_of: new Date(now).toISOString(), timezone,
    brief: { status: brief?.sent ? 'sent_recorded' as const : !brief || brief.time === null ? 'not_scheduled' as const : 'not_sent' as const, at: null },
    waiting: { count: waiting.length, first: waiting[0] ? { id: waiting[0].id, summary: waiting[0].summary } : null },
    next_card: next ? { id: next.id, label: next.label, scheduled_at: next.scheduled_at } : null,
    latest_activity: activity,
    services: input.grants.map((grant) => ({
      account_id: grant.id, email: grant.email,
      grants: [grant.calendar ? 'calendar' as const : null, grant.mail ? 'gmail' as const : null, grant.tasks ? 'tasks' as const : null].filter((value): value is 'calendar' | 'gmail' | 'tasks' => value !== null),
      health: grant.error ? 'needs_reconnect' as const : 'access_granted' as const,
    })),
  };
};
