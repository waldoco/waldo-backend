import type { AppNodeSourceV1 } from '../../../contracts/src/app/controls';
import type { HealthReadSignal } from '@waldo/contracts';
import { GoogleError, type CalendarItem, type GoogleClient, type MailItem, type TaskItem } from '../connectors/google';
import { parseSeries, type Reading } from '../health/producer';
import { shiftDay } from '../health/scores/time';
import { chooseGroup, foldDay, localDayOf, SIGNALS, type HealthReadBook } from '../tools/live/health';
import type { GoogleAccess } from '../tools/live/google';
import type { FindingStore } from './findings';
import type { ClaimStore } from '../memory/claims';
import { heldTopicsOf, holdsIn } from '../memory/forget-guard';
import { numericHealthIn } from '../scribe/sanitiser';
import { isSetupRef } from './first-run';
import { runWelcome, welcomeBuild, type StageInput, type WelcomeStage } from './welcome';

// What each source gives the welcome build: bounded reads, as pointers to the items, never their contents.
export const WELCOME_HEALTH_DAYS = 30;
const CALENDAR_PAST_DAYS = 60, CALENDAR_AHEAD_DAYS = 14, CALENDAR_PAGES = 3, CALENDAR_PAGE = 100, TASKS_PAGE = 100;
const MAIL_DAYS = 90, MAIL_PAGES = 4, MAIL_PAGE = 50;
// Mail Waldo was sent in bulk says little about the owner's life.
const MAIL_QUERY = `newer_than:${MAIL_DAYS}d -category:promotions -category:social`;
const DAY_MS = 86_400_000;

const settled = (state: Extract<StageInput, { kind: 'settled' }>['state']): StageInput => ({ kind: 'settled', state });
const input = (lines: readonly string[], sources: Iterable<AppNodeSourceV1>, pointers: Iterable<string>): StageInput =>
  lines.length ? { kind: 'input', text: lines.join('\n'), sources: [...new Set(sources)], pointers: new Set(pointers) } : settled('empty');

// Device readings come from Apple Health or Health Connect (Samsung's watch writes through Health Connect). WHOOP and Oura are
// not welcome sources.
const HEALTH_SOURCES: Readonly<Record<string, AppNodeSourceV1>> = { apple: 'apple_health', health_connect: 'health_connect', samsung: 'health_connect' };

// Readings go to the model only inside its untainted welcome call; nothing here is stored. An owner who keeps health out of
// memory gets no health nodes, so the stage reads nothing.
export const healthStage = (book: HealthReadBook, timezone: () => string, now: () => number, healthMemory: () => boolean) => async (): Promise<StageInput> => {
  if (!healthMemory()) return settled('skipped');
  const consent = await book.consent();
  if (consent.kind === 'consent_withdrawn') return settled('revoked');
  if (consent.kind === 'read_failed') return settled('unavailable');
  if (consent.kind !== 'granted') return settled('skipped');
  const zone = timezone(), to = localDayOf(new Date(now()), zone), from = shiftDay(to, -(WELCOME_HEALTH_DAYS - 1));
  const signals = Object.keys(SIGNALS) as HealthReadSignal[];
  const parsed = parseSeries(await book.series({ from, to, signals: signals.map((signal) => SIGNALS[signal].stored) }));
  if (parsed.kind === 'no_consent') return settled('skipped');
  if (parsed.kind === 'failed') return settled('unavailable');
  const lines: string[] = [], sources: AppNodeSourceV1[] = [], pointers: string[] = [];
  // The same read get_health makes: time asleep only, a sleep stage from its own share of the night, one source and one
  // method per signal, so methods never blend.
  const live = parsed.series.sources.filter((source) => HEALTH_SOURCES[source.source] !== undefined && consent.sources.has(source.source));
  for (const signal of signals) {
    const group = chooseGroup(signal, live);
    if (!group) continue;
    const tag = HEALTH_SOURCES[group.source]!;
    const byDay = new Map<string, Reading[]>();
    for (const reading of group.readings) byDay.set(reading.day, [...(byDay.get(reading.day) ?? []), reading]);
    const days = [...byDay.keys()].sort().map((day) => `${day} ${foldDay(SIGNALS[signal].fold, byDay.get(day)!, zone)}`);
    lines.push(`${signal} (${tag}, ${SIGNALS[signal].unit}${group.method ? `, ${group.method}` : ''}): ${days.join('; ')}`);
    sources.push(tag); pointers.push(signal);
  }
  return input(lines, sources, pointers);
};

type Account = Readonly<{ email: string; error: string | null; calendar: boolean; mail: boolean; tasks: boolean }>;
// A dead grant or a missing scope is the owner's revoked access; anything else is a failed read.
const revokedAccess = (error: unknown) => error instanceof GoogleError && (error.status === 401 || (error.status === 403 && error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'));

// Every connected Google account, each named on its own reads, until the shared multi-account read lands.
const perAccount = async (google: GoogleAccess, wants: (account: Account) => boolean,
  read: (account: Account) => Promise<readonly string[] | 'revoked'>): Promise<Readonly<{ lines: string[]; revoked: boolean; any: boolean }>> => {
  const accounts = ((await google.state?.()) ?? []).filter(wants);
  const lines: string[] = [];
  let revoked = false;
  for (const account of accounts) {
    if (account.error !== null) { revoked = true; continue; }
    const got = await read(account);
    if (got === 'revoked') revoked = true; else lines.push(...got);
  }
  return { lines, revoked, any: accounts.length > 0 };
};
const guarded = async (work: () => Promise<readonly string[]>): Promise<readonly string[] | 'revoked'> => {
  try { return await work(); } catch (error) { if (revokedAccess(error)) return 'revoked'; throw error; }
};

const eventLine = (event: CalendarItem) => `[${event.id}] ${event.title} · ${event.all_day ? `${event.start.slice(0, 10)} all day` : event.start}${event.attendees ? ` · ${event.attendees} people` : ''}${event.recurring_event_id ? ' · repeats' : ''}`;
const taskLine = (task: TaskItem) => `[${task.id}] task: ${task.title} · ${task.status === 'done' ? 'done' : 'open'}${task.due ? ` · due ${task.due.slice(0, 10)}` : ''}`;

// Titles, times, repeats and how many people: no descriptions, no attendee names or addresses.
export const calendarStage = (google: GoogleAccess, now: () => number) => async (): Promise<StageInput> => {
  const from = new Date(now() - CALENDAR_PAST_DAYS * DAY_MS).toISOString(), to = new Date(now() + CALENDAR_AHEAD_DAYS * DAY_MS).toISOString();
  const sources = new Set<AppNodeSourceV1>(), pointers = new Set<string>();
  const events = async (client: GoogleClient): Promise<readonly CalendarItem[]> => {
    if (!client.calendarPage) return client.events(from, to, CALENDAR_PAGE, false);
    const all: CalendarItem[] = [];
    let token: string | undefined;
    for (let page = 0; page < CALENDAR_PAGES; page += 1) {
      const read = await client.calendarPage('primary', from, to, CALENDAR_PAGE, false, token);
      all.push(...read.events);
      if (!read.next_page_token) break;
      token = read.next_page_token;
    }
    return all;
  };
  const calendar = await perAccount(google, (account) => account.calendar, (account) => guarded(async () => {
    const client = await google.client('calendar', undefined, undefined, account.email);
    if (!client) return [];
    const read = (await events(client)).filter((event) => event.status !== 'cancelled');
    if (read.length) sources.add('calendar');
    read.forEach((event) => pointers.add(event.id));
    return read.map(eventLine);
  }));
  const tasks = await perAccount(google, (account) => account.tasks, (account) => guarded(async () => {
    const client = await google.client('tasks', undefined, undefined, account.email);
    if (!client) return [];
    const read = client.allTasksPage ? (await client.allTasksPage('all', TASKS_PAGE)).tasks : await client.tasks('all', TASKS_PAGE);
    if (read.length) sources.add('tasks');
    read.forEach((task) => pointers.add(task.id));
    return read.map(taskLine);
  }));
  if (!calendar.any && !tasks.any) return settled('skipped');
  const lines = [...calendar.lines, ...tasks.lines];
  if (!lines.length && (calendar.revoked || tasks.revoked)) return settled('revoked');
  return input(lines, sources, pointers);
};

// Who the owner writes with, and the subject lines: never a body or a snippet. A sender is a display name and a domain.
const sender = (from: string) => {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const name = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  const domain = address.includes('@') ? address.split('@').pop()!.trim() : '';
  return [name || null, domain ? `(${domain})` : null].filter(Boolean).join(' ');
};
const mailLine = (item: MailItem) => `[${item.thread_id}] ${sender(item.from)} · ${item.subject} · ${item.at.slice(0, 10)}`;

export const mailStage = (google: GoogleAccess) => async (): Promise<StageInput> => {
  const pointers = new Set<string>();
  const mail = await perAccount(google, (account) => account.mail, (account) => guarded(async () => {
    const client = await google.client('mail', undefined, undefined, account.email);
    if (!client) return [];
    const lines: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAIL_PAGES; page += 1) {
      const read = await client.mailPage(MAIL_QUERY, MAIL_PAGE, token);
      for (const item of read.messages) if (!pointers.has(item.thread_id)) { pointers.add(item.thread_id); lines.push(mailLine(item)); }
      if (!read.next_page_token) break;
      token = read.next_page_token;
    }
    return lines;
  }));
  if (!mail.any) return settled('skipped');
  if (!mail.lines.length && mail.revoked) return settled('revoked');
  return input(mail.lines, ['gmail'], pointers);
};

// The owner's own setup answers, as they are now: owner-grounded words only, never Waldo's reads or outside text, and nothing a
// forget still holds. An owner who keeps health out of memory gets neither their health picks nor a stated reading here, and no
// health node from this stage.
export const setupStage = (claims: ClaimStore, healthMemory: () => boolean) => async (): Promise<StageInput> => {
  const health = healthMemory(), held = holdsIn(heldTopicsOf(claims));
  const said = [...claims.claims(), ...claims.claims('promoted')].filter((claim) => isSetupRef(claim.source_ref) && claim.origin === 'owner'
    && claim.verification_status === 'owner-grounded' && !held(claim.text) && (health || (claim.kind !== 'health' && !numericHealthIn(claim.text))));
  if (!said.length) return settled('skipped');
  const pointer = (id: number) => `c${id}`;
  return {
    kind: 'input', text: said.map((claim) => `[${pointer(claim.id)}] ${claim.text}`).join('\n'), sources: ['setup'],
    pointers: new Set(said.map((claim) => pointer(claim.id))), cites: new Map(said.map((claim) => [pointer(claim.id), claim.id])),
    ...(health ? {} : { noHealth: true }),
  };
};

// The public web reaches the gift only as look-up findings, which the app reads on their own route with their own keep,
// correct and forget. This stage writes no node: it says whether the look-up is live and found anything.
export const webStage = (findings: Pick<FindingStore, 'offered' | 'lookup' | 'page'>) => async (): Promise<StageInput> => {
  if (!findings.offered() || findings.lookup() !== 'granted') return settled('skipped');
  return settled(findings.page(1).total > 0 ? 'done' : 'empty');
};

// A few signals any wearable sends, enough to tell whether a reading has landed in the welcome window.
const LANDED_SIGNALS = ['sleep_duration', 'resting_heart_rate', 'steps_window', 'workout'];
const healthLanded = async (book: HealthReadBook, granted: ReadonlySet<string>, timezone: string, now: number): Promise<boolean> => {
  const to = localDayOf(new Date(now), timezone);
  const parsed = parseSeries(await book.series({ from: shiftDay(to, -(WELCOME_HEALTH_DAYS - 1)), to, signals: LANDED_SIGNALS }));
  return parsed.kind === 'series' && parsed.series.sources.some((source) => HEALTH_SOURCES[source.source] !== undefined && granted.has(source.source) && source.readings.length > 0);
};

// Whether a waiting stage's source is there now: a cheap check, and for health whether a reading has landed to build from.
export const welcomeSourceAvailable = (deps: Readonly<{ claims: ClaimStore; healthMemory(): boolean; healthRead: HealthReadBook; google: GoogleAccess; findings(): Pick<FindingStore, 'offered' | 'lookup'>; now(): number; timezone(): string }>) =>
  async (stage: WelcomeStage): Promise<boolean> => {
    const accounts = async (wants: (account: Account) => boolean) => ((await deps.google.state?.()) ?? []).some((account) => wants(account) && account.error === null);
    switch (stage) {
      case 'health': {
        if (!deps.healthMemory()) return false;
        const consent = await deps.healthRead.consent();
        return consent.kind === 'granted' && healthLanded(deps.healthRead, consent.sources, deps.timezone(), deps.now());
      }
      case 'calendar': return accounts((account) => account.calendar || account.tasks);
      case 'mail': return accounts((account) => account.mail);
      case 'web': { const findings = deps.findings(); return findings.offered() && findings.lookup() === 'granted'; }
      case 'setup': return (await setupStage(deps.claims, deps.healthMemory)()).kind === 'input';
    }
  };

// The owner object's welcome run: the readers over its own connections, and one model call per stage, which the owner object
// runs as an owner job on its queue.
export const ownerWelcome = (deps: Readonly<{
  sql: Pick<SqlStorage, 'exec'>; transaction<T>(work: () => T): T; claims: ClaimStore; now(): number; timezone(): string; healthMemory(): boolean;
  healthRead: HealthReadBook; google: GoogleAccess; findings(): Pick<FindingStore, 'offered' | 'lookup' | 'page'>;
  ask(stage: WelcomeStage, input: string): Promise<string>;
}>) => ({
  build: () => welcomeBuild(deps.sql, deps.now),
  // Something to do: a stage due, or a skipped stage to check for its source.
  wanted: () => { const build = welcomeBuild(deps.sql, deps.now); return build.due().length > 0 || build.reopenable().length > 0; },
  // Health readings may have landed since an empty health stage: take it up once more, within a day of it settling.
  lateHealth: (): boolean => deps.transaction(() => welcomeBuild(deps.sql, deps.now).lateHealth()),
  run: () => runWelcome({
    build: welcomeBuild(deps.sql, deps.now), claims: deps.claims, now: deps.now, transaction: deps.transaction, ask: deps.ask, available: welcomeSourceAvailable(deps),
    read: { health: healthStage(deps.healthRead, deps.timezone, deps.now, deps.healthMemory), calendar: calendarStage(deps.google, deps.now), mail: mailStage(deps.google), web: () => webStage(deps.findings())(), setup: setupStage(deps.claims, deps.healthMemory) },
  }),
});
export type OwnerWelcome = ReturnType<typeof ownerWelcome>;
