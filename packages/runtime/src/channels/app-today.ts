import { z } from 'zod';
import { calendarEventCategoryV1Schema } from '../../../contracts/src/app/calendar-day';
import { appTodayV1Schema, type AppTodayV1 } from '../../../contracts/src/app/today';

// The owner's day at a glance, for the widget, intents and AppFunctions. The Worker asks the owner's Durable Object for the same
// three answers the app's own screens read (calendar day, approvals, the day view), under the same session and contract
// header, and keeps only what a glance needs. Each answer is read for the few fields it needs and nothing stricter, so a later
// revision of those contracts does not break this one; a part that cannot be read is answered unavailable on its own.
type Read = (pathAndQuery: string) => Promise<Response>;

export const APP_TODAY_PATH = '/app/v1/today';

const instant = z.iso.datetime({ offset: true });
const calendarAnswer = z.object({
  day: z.string(), timezone: z.string(),
  calendar: z.object({ state: z.enum(['not_connected', 'needs_reconnect', 'available']) }),
  events: z.array(z.object({ id: z.string(), title: z.string(), start: instant, end: instant, category: calendarEventCategoryV1Schema.catch('other') })),
});
const approvalsAnswer = z.object({ approvals: z.array(z.object({ state: z.string() })) });
const dayAnswer = z.object({
  view: z.literal('day'),
  data: z.object({ cards: z.array(z.object({ id: z.string(), latest: z.object({ delivered_at: z.number(), excerpt: z.string() }).nullable().optional() })) }),
});

const answer = async <T>(read: Read, path: string, schema: z.ZodType<T>): Promise<T | null> => {
  try {
    const response = await read(path);
    if (!response.ok) return null;
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch { return null; }
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

export const appToday = async (read: Read, now = Date.now()): Promise<Response> => {
  const [day, approvals, controls] = await Promise.all([
    answer(read, '/app/v1/calendar/day', calendarAnswer),
    answer(read, '/app/v1/approvals', approvalsAnswer),
    answer(read, '/app/v1/controls?view=day', dayAnswer),
  ]);
  const parsed = appTodayV1Schema.safeParse({
    compiled_at: new Date(now).toISOString(),
    day: day?.day ?? null,
    timezone: day?.timezone ?? null,
    calendar: calendarPart(day, now),
    approvals: approvals ? { state: 'available', waiting: approvals.approvals.filter(card => card.state === 'open').length } : { state: 'unavailable' },
    brief: briefPart(controls),
  });
  if (!parsed.success) console.error('app today shape');
  return Response.json(parsed.success ? parsed.data : { error: 'unavailable' }, { status: parsed.success ? 200 : 503, headers: { 'cache-control': 'no-store' } });
};
