import { z } from 'zod';
import { calendarEventCategoryV1Schema } from '../../../contracts/src/app/calendar-day';
import { healthDayV1Schema, healthTimezoneV1Schema } from '../../../contracts/src/app/health-ingest';
import { APP_TODAY_DEADLINE_MS_V1, appTodayV1Schema, type AppTodayV1 } from '../../../contracts/src/app/today';

// The owner's day at a glance, for the widget, intents and AppFunctions. The Worker asks the owner's Durable Object for the same
// three answers the app's own screens read (calendar day, approvals, the day view), under the same session and contract
// header, and keeps only what a glance needs. Each answer is read for the few fields it needs and nothing stricter, so a later
// revision of those contracts does not break this one. A part that cannot be read in time, or reads wrong, is answered
// unavailable on its own and logged by a fixed code, never its content; the rest still answer.
type Read = (pathAndQuery: string) => Promise<Response>;

export const APP_TODAY_PATH = '/app/v1/today';

const instant = z.iso.datetime({ offset: true });
const calendarAnswer = z.object({
  day: healthDayV1Schema, timezone: healthTimezoneV1Schema,
  calendar: z.object({ state: z.enum(['not_connected', 'needs_reconnect', 'available']) }),
  events: z.array(z.object({ id: z.string(), title: z.string(), start: instant, end: instant, category: calendarEventCategoryV1Schema.catch('other') })),
});
const approvalsAnswer = z.object({ approvals: z.array(z.object({ state: z.string() })) });
const dayAnswer = z.object({
  view: z.literal('day'),
  data: z.object({ cards: z.array(z.object({ id: z.string(), latest: z.object({ delivered_at: z.number(), excerpt: z.string() }).nullable().optional() })) }),
});

type Part = 'calendar' | 'approvals' | 'brief';
const fault = (part: Part, code: string) => console.error(JSON.stringify({ hop: 'app_today', part, code }));
const LATE = Symbol('late');

const answer = async <T>(read: Read, part: Part, path: string, schema: z.ZodType<T>, deadline: Promise<typeof LATE>): Promise<T | null> => {
  const asked = (async (): Promise<{ data: T } | { code: string }> => {
    const response = await read(path);
    if (!response.ok) return { code: `status_${response.status}` };
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? { data: parsed.data } : { code: 'shape' };
  })().catch(() => ({ code: 'thrown' }));
  const result = await Promise.race([asked, deadline]);
  if (result === LATE) { fault(part, 'deadline'); return null; }
  if ('code' in result) { fault(part, result.code); return null; }
  return result.data;
};

// Each part is checked against its own slot in the contract, so one that reads wrong costs only itself.
const settle = <K extends Part>(part: K, value: AppTodayV1[K]): AppTodayV1[K] => {
  const parsed = appTodayV1Schema.shape[part].safeParse(value);
  if (parsed.success) return parsed.data as AppTodayV1[K];
  fault(part, 'shape');
  return { state: 'unavailable' } as AppTodayV1[K];
};

const calendarPart = (day: z.infer<typeof calendarAnswer> | null, now: number): AppTodayV1['calendar'] => {
  if (!day) return { state: 'unavailable' };
  if (day.calendar.state !== 'available') return { state: day.calendar.state };
  const events = day.events.map(({ id, title, start, end, category }) => ({ id, title, start, end, category }));
  const under = events.filter(item => Date.parse(item.start) <= now && Date.parse(item.end) > now);
  return {
    state: 'available',
    now: under.at(-1) ?? null,
    next: events.find(item => Date.parse(item.start) > now) ?? null,
    left: events.filter(item => Date.parse(item.end) > now).length,
  };
};

const briefPart = (day: z.infer<typeof dayAnswer> | null): AppTodayV1['brief'] => {
  if (!day) return { state: 'unavailable' };
  const card = day.data.cards.find(item => item.id === 'card:brief');
  if (!card) return { state: 'not_delivered' };
  // The day view leaves latest out when it cannot read the chat, and says null when nothing was delivered.
  if (card.latest === undefined) return { state: 'unavailable' };
  return card.latest ? { state: 'delivered', excerpt: card.latest.excerpt, delivered_at: card.latest.delivered_at } : { state: 'not_delivered' };
};

// The three reads share one deadline: a slow calendar (Google, several accounts) answers unavailable while the rest answer.
// What is still in flight when the Worker answers ends with the request.
export const appToday = async (read: Read, now = Date.now(), deadlineMs = APP_TODAY_DEADLINE_MS_V1): Promise<Response> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof LATE>(resolve => { timer = setTimeout(() => resolve(LATE), deadlineMs); });
  const [day, approvals, controls] = await Promise.all([
    answer(read, 'calendar', '/app/v1/calendar/day', calendarAnswer, deadline),
    answer(read, 'approvals', '/app/v1/approvals', approvalsAnswer, deadline),
    answer(read, 'brief', '/app/v1/controls?view=day', dayAnswer, deadline),
  ]).finally(() => clearTimeout(timer));
  const today: AppTodayV1 = {
    compiled_at: new Date(now).toISOString(),
    day: day?.day ?? null,
    timezone: day?.timezone ?? null,
    calendar: settle('calendar', calendarPart(day, now)),
    approvals: settle('approvals', approvals ? { state: 'available', waiting: approvals.approvals.filter(card => card.state === 'open').length } : { state: 'unavailable' }),
    brief: settle('brief', briefPart(controls)),
  };
  return Response.json(today, { headers: { 'cache-control': 'no-store' } });
};
