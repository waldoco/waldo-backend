import type { ApprovalReview } from './approvals';
import { consoleMayApprove, type ConsoleView } from './console';
import { E2E_STEPS } from './harness';

export const CONTROLS_PATH = '/console/dashboard/api/v1/controls';
export const CONTROLS_VIEWS = ['day', 'connections', 'waiting', 'activity', 'profile', 'setup', 'usage', 'files'] as const;
export type ControlsView = (typeof CONTROLS_VIEWS)[number];
type ControlsQuery = Readonly<{ view: ControlsView; page: { traceBefore?: number; runsBefore?: number } }>;

// These parameters select a presentation and cursors, never an owner or permission.
export function readControlsQuery(params: URLSearchParams): ControlsQuery | null {
  if ([...params.keys()].some((key) => !['view', 'trace_before', 'runs_before'].includes(key) || params.getAll(key).length !== 1)) return null;
  const view = CONTROLS_VIEWS.find((item) => item === params.get('view'));
  if (!view) return null;
  const page: ControlsQuery['page'] = {};
  for (const [key, field] of [['trace_before', 'traceBefore'], ['runs_before', 'runsBefore']] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    if (view !== 'activity' || !/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) return null;
    page[field] = Number(raw);
  }
  return { view, page };
}

const safeReview = (review: ApprovalReview | null): ApprovalReview | null => {
  if (!review) return null;
  if (review.kind === 'email_send') return { kind: review.kind, to: [...review.to], cc: [...review.cc], bcc: [...review.bcc], subject: review.subject, body: review.body };
  if (review.kind === 'message_send') return { kind: review.kind, channel: review.channel, content: review.content };
  return { kind: review.kind, action: review.action, title: review.title, event_id: review.event_id, start: review.start, end: review.end, reason: review.reason };
};

const projections = {
  day: (view: ConsoleView) => ({
    timezone: view.timezone,
    date: view.now.slice(0,10),
    cards: view.cards.map((card) => ({ id: card.id, name: card.name, defaultTime: card.defaultTime, time: card.time, reason: card.reason, sent: card.sent, pin: card.pin })),
    proactivity: { quiet_start: view.proactivity.quiet_start, quiet_end: view.proactivity.quiet_end, volume: view.proactivity.volume },
  }),
  connections: (view: ConsoleView) => ({
    google: {
      connectAvailable: view.google.connectAvailable,
      accounts: view.google.accounts.map((account) => ({ id: account.id, email: account.email, calendar: account.calendar, mail: account.mail, tasks: account.tasks, health: account.error ? 'needs_reconnect' as const : 'access_granted' as const })),
    },
    telegram: { linked: view.telegram.linked, unlinkAvailable: view.telegram.unlinkAvailable },
    sessions: { until: view.sessionUntil, count: view.sessionCount, items: view.sessions.map((row) => ({ signed_in: row.signed_in, until: row.until, current: row.current })) },
  }),
  waiting: (view: ConsoleView) => ({
    // Proposal times are instants; the console draws them in this owner zone when it can read it.
    timezone: view.timezone,
    proposals: view.approvals.map((item) => {
      const review = item.review?.kind === item.kind ? safeReview(item.review) : null;
      const canApprove = consoleMayApprove(item) && review !== null;
      const dismissible = (item.state === 'open' || item.state === 'review_only') && !canApprove && (item.kind === 'email_send' || item.kind === 'message_send');
      const actions = canApprove ? ['approval.approve', 'approval.skip']
        : item.state === 'open' || item.state === 'review_only' ? dismissible ? ['approval.skip'] : []
          : item.undoable ? ['approval.undo'] : [];
      return { id: item.id, kind: item.kind, summary: item.summary, state: item.state, review, actions };
    }),
  }),
  activity: (view: ConsoleView) => ({
    // steps are scheduled and background jobs only; the request pipeline is last_request, read from one trace.
    steps: view.steps.filter((step) => E2E_STEPS.some((known) => known.step === step.step && known.scope === 'job')).map((step) => ({ step: step.step, state: step.state, at: step.at, note: step.note })),
    last_request: view.lastRequest ? { trace: view.lastRequest.trace, at: view.lastRequest.at, ok: view.lastRequest.ok, hops: view.lastRequest.hops.map((hop) => ({ hop: hop.hop, ok: hop.ok, ms: hop.ms, note: hop.note })) } : null,
    trace: [...view.trace].reverse().map((row) => ({ time: row.time, hop: row.hop, ok: row.ok, ms: row.ms, summary: row.note || null })),
    runs: view.runs.map((run) => ({ id: run.id, kind: run.kind, status: run.status, summary: run.summary, started: run.started, ended: run.ended })),
    page: { trace_before: view.page?.trace_before ?? null, runs_before: view.page?.runs_before ?? null, trace_applied: view.page?.trace_applied ?? null, runs_applied: view.page?.runs_applied ?? null },
    ledger: view.ledger,
  }),
  profile: (view: ConsoleView) => ({
    // Existing removal may leave derived text behind. Do not present that text as settled.
    sections: view.forgettingSpots.length ? [] : view.profile.map((section) => ({ title: section.title, lines: [...section.lines] })),
    barriers: view.barriers,
    removal: { state: view.forgettingSpots.length ? 'incomplete' as const : 'none_recorded' as const, pending_count: view.forgettingSpots.length },
    holds: view.holds.map((hold) => ({ kind: hold.kind, reason: hold.reason, created_at: hold.created_at })),
  }),
  setup: (view: ConsoleView) => ({
    telegram_linked: view.telegram.linked,
    google_access_granted: view.google.accounts.some((account) => !account.error),
    quiet_hours_set: view.proactivity.quiet_start !== null,
  }),
  usage: (view: ConsoleView) => ({ rows: view.usage.map((row) => ({ model: row.model, calls: row.calls, input: row.input, cached: row.cached, output: row.output, usd: row.usd })) }),
  files: (view: ConsoleView) => ({
    storage: 'telegram_reference' as const,
    items: view.files.map((file) => ({ id: file.id, kind: file.kind, name: file.name, mime: file.mime, size: file.size, caption: file.caption, at: file.at })),
  }),
};

// Called after the existing owner-session check. The CSRF value is scoped to that
// session for existing supported actions; no session credential is projected.
export function projectControls<T extends ControlsView>(view: ConsoleView, selected: T) {
  return { version: 1 as const, view: selected, state: 'available' as const, csrf: view.csrf, data: projections[selected](view) as ReturnType<(typeof projections)[T]> };
}
