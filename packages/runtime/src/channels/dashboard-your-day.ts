// Narrow read projection for the dashboard "your day" page: card timing, pins, quiet hours.
// Pure function over owner-DO state, never ConsoleView. The planner's free-text reason is not
// emitted (it can carry model text); state is a closed value derived from stored fields.
// Writes stay on the existing CSRF console actions (card.today, card.pin, card.unpin, proactivity.set).
import type { Proactivity } from './loops';

export const DASHBOARD_YOUR_DAY_PATH = '/console/dashboard/api/v1/your-day';

type Card = Readonly<{ id: string; name: string; defaultTime: string; time: string | null; sent: boolean; pin: string | null; reason?: string }>;

export const dashboardYourDay = (input: Readonly<{ now: number; timezone: string; cards: readonly Card[]; proactivity: Proactivity }>) => ({
  version: 1 as const,
  as_of: new Date(input.now).toISOString(),
  timezone: input.timezone,
  cards: input.cards.map((card) => ({
    id: card.id, name: card.name, default_time: card.defaultTime, time: card.time,
    state: card.sent ? 'sent' as const : card.time === null ? 'not_scheduled' as const : 'upcoming' as const,
    pinned_time: card.pin, editable: !card.sent,
  })),
  quiet_hours: { start: input.proactivity.quiet_start, end: input.proactivity.quiet_end, set: input.proactivity.quiet_start !== null },
  volume: input.proactivity.volume,
});
