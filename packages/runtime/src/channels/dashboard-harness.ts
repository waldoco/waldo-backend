import { HARNESS_MESSAGE_LIMIT } from '../memory/held-rows';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { errorClass } from '../observability/trace-privacy';
import { parseHarnessCommand, type HarnessCommand } from './harness';

export const DASHBOARD_HARNESS_PATH = '/console/dashboard/api/v1/harness';

export type ConsoleHarnessCommand = Exclude<HarnessCommand, Readonly<{ kind: 'console' }>>;
// Which commands the console runs, and which budget each spends: a fire with a job runs that job now, the rest read. /console
// is the page itself, so it is not one.
const IN_CONSOLE: Record<HarnessCommand['kind'], 'read' | 'action' | null> = { fire: 'action', trace: 'read', e2e: 'read', console: null, usage: 'read', langfuse: 'read', heldrows: 'read' };
// The owner's diagnostics read only their own Waldo. A fire runs model-backed jobs and /langfuse writes to the deploy-wide
// trace project, so those two are for admins.
const FOR_ADMINS: ReadonlySet<HarnessCommand['kind']> = new Set(['fire', 'langfuse']);
export const CONSOLE_DIAGNOSTICS = ['/trace', '/e2e', '/usage', '/heldrows', '/ledger'] as const;
export const CONSOLE_ADMIN_COMMANDS = ['/langfuse', '/fire'] as const;
// A fire runs a real job: each job at most once in FIRE_SPACING_MS, and at most FIRE_DAILY_LIMIT fires in the 24 hours from
// the first fire of the current count, for each owner.
export const FIRE_SPACING_MS = 10 * 60_000;
export const FIRE_DAILY_LIMIT = 20;
const DAY_MS = 24 * 60 * 60_000;

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
export type HarnessRefusal = Readonly<{ reason: 'admin_only' | 'unavailable' | 'budget' } | { reason: 'wait'; seconds: number }>;

// Whether a command may run now on a deploy with the directory, wherever it was typed: the console and every chat surface
// pass through here. Admin commands
// need the directory's admin check. A fire is recorded when admitted, before it runs, so a fire that then fails or finds the
// account unconfirmed still uses its slot: a failing job is not retried into a loop of model work. The spacing is checked
// before `budget` (the console's action budget, shared with approvals), so a refused fire spends none of it; the clock is read
// after the admin check, and the check and record that follow run with no await between them.
export const admitHarnessCommand = async (command: HarnessCommand, gate: Readonly<{ admin(): Promise<boolean>; kv: Kv; now(): number; budget?(): boolean }>): Promise<HarnessRefusal | null> => {
  if (FOR_ADMINS.has(command.kind)) {
    let admin: boolean;
    try { admin = await gate.admin(); } catch { return { reason: 'unavailable' }; }
    if (!admin) return { reason: 'admin_only' };
  }
  const target = command.kind === 'fire' ? command.target : null;
  const now = gate.now();
  const wait = target ? fireWait(gate.kv, target, now) : null;
  if (wait !== null) return { reason: 'wait', seconds: wait };
  if (gate.budget && !gate.budget()) return { reason: 'budget' };
  if (target) recordFire(gate.kv, target, now);
  return null;
};

export const waitText = (seconds: number): string => {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 90) return minutes === 1 ? 'a minute' : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hours`;
};

// The answer to a refused command typed in a chat.
export const harnessRefusalText = (refusal: HarnessRefusal): string =>
  refusal.reason === 'admin_only' ? 'That command is for Waldo admins.'
    : refusal.reason === 'wait' ? `Not yet: try again in ${waitText(refusal.seconds)}.`
      : 'Waldo could not check that command just now, so nothing ran.';

// Commands Telegram took, in the owner's console (CONSOLE_HARNESS): the same handlers, run as the signed-in owner behind the
// console's session, CSRF token and rate budget. A GET says which commands this owner has and carries this session's token;
// with the switch off the route is not there. /stop has its own homes (a message's stop and WhatsApp's /stop) and is no
// command here.
export const consoleHarness = async (input: Readonly<{
  request: Request; csrf: string; enabled: boolean;
  admin(): Promise<boolean>;
  admit(command: HarnessCommand, budget: () => boolean): Promise<HarnessRefusal | null>;
  limited(kind: 'read' | 'action'): Response | null;
  run(command: ConsoleHarnessCommand): Promise<string>;
  ledger(): Promise<string>;
}>): Promise<Response> => {
  const reply = (body: object, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...DASHBOARD_OVERVIEW_HEADERS, ...extra } });
  if (!input.enabled) return reply({ error: 'not_found' }, 404);
  if (input.request.method === 'GET') {
    const limited = input.limited('read');
    if (limited) return limited;
    const admin = await input.admin().catch(() => false);
    return reply({ version: 1, csrf: input.csrf, commands: [...CONSOLE_DIAGNOSTICS, ...(admin ? CONSOLE_ADMIN_COMMANDS : [])] });
  }
  if (input.request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
  let form: FormData;
  try { form = await input.request.formData(); } catch { return reply({ error: 'invalid_request' }, 400); }
  if (form.get('csrf') !== input.csrf) return reply({ error: 'forbidden' }, 403);
  const text = String(form.get('command') ?? '').trim();
  const parsed = text === '/ledger' ? null : parseHarnessCommand(text);
  // A /fire naming no job only answers its usage line, so it spends a read.
  const budget = text === '/ledger' ? 'read' : parsed ? (parsed.kind === 'fire' && parsed.target === null ? 'read' : IN_CONSOLE[parsed.kind]) : null;
  if (budget === null) return reply({ error: 'invalid_command' }, 400);
  let limited = null as Response | null;
  const spend = () => !(limited = input.limited(budget));
  const refusal = parsed ? await input.admit(parsed, spend) : spend() ? null : { reason: 'budget' as const };
  if (limited) return limited;
  if (refusal?.reason === 'admin_only') return reply({ error: 'admin_only' }, 403);
  if (refusal?.reason === 'unavailable') return reply({ error: 'unavailable' }, 503);
  if (refusal?.reason === 'wait') return reply({ error: 'rate_limited' }, 429, { 'retry-after': String(refusal.seconds) });
  try {
    return reply({ output: (parsed ? await input.run(parsed as ConsoleHarnessCommand) : await input.ledger()).slice(0, HARNESS_MESSAGE_LIMIT) });
  } catch (error) {
    console.error(JSON.stringify({ hop: 'console_harness', ok: false, code: 'command_failed', error_class: errorClass(error) }));
    return reply({ error: 'unavailable' }, 503);
  }
};

const spacingKey = (target: string) => `console:fire-at:${target}`;
const DAILY_KEY = 'console:fire-day';
type FireDay = Readonly<{ start: number; count: number }>;
const fireDay = (kv: Kv, now: number): FireDay => {
  const day = kv.get<FireDay>(DAILY_KEY);
  return day && now - day.start < DAY_MS ? day : { start: now, count: 0 };
};

// Seconds until this fire may run, or null when it may run now.
const fireWait = (kv: Kv, target: string, now: number): number | null => {
  const last = kv.get<number>(spacingKey(target));
  if (last !== undefined && now - last < FIRE_SPACING_MS) return Math.ceil((last + FIRE_SPACING_MS - now) / 1000);
  const day = fireDay(kv, now);
  return day.count >= FIRE_DAILY_LIMIT ? Math.ceil((day.start + DAY_MS - now) / 1000) : null;
};

const recordFire = (kv: Kv, target: string, now: number): void => {
  const day = fireDay(kv, now);
  kv.put(spacingKey(target), now);
  kv.put(DAILY_KEY, { start: day.start, count: day.count + 1 });
};
