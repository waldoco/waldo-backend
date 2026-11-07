import { HARNESS_MESSAGE_LIMIT } from '../memory/held-rows';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { parseHarnessCommand, type HarnessCommand } from './harness';

export const DASHBOARD_HARNESS_PATH = '/console/dashboard/api/v1/harness';

export type ConsoleHarnessCommand = Exclude<HarnessCommand, Readonly<{ kind: 'console' }>>;
// Which commands the console runs, and which budget each spends: a fire with a job runs that job now, the rest read. /console
// is the page itself, so it is not one.
const IN_CONSOLE: Record<HarnessCommand['kind'], 'read' | 'action' | null> = { fire: 'action', trace: 'read', e2e: 'read', console: null, usage: 'read', langfuse: 'read', heldrows: 'read' };
export const CONSOLE_HARNESS_COMMANDS = ['/trace', '/e2e', '/usage', '/langfuse', '/heldrows', '/fire', '/ledger'] as const;

// The operator commands Telegram took, for the owner in the console (CONSOLE_HARNESS): the same handlers, run as the
// signed-in owner behind the console's session, CSRF token and rate budget. A GET says the commands are here and carries
// this session's token; with the switch off the route is not there. /stop has its own homes (a message's stop and
// WhatsApp's /stop) and is no command here.
export const consoleHarness = async (input: Readonly<{
  request: Request; csrf: string; enabled: boolean;
  limited(kind: 'read' | 'action'): Response | null;
  run(command: ConsoleHarnessCommand): Promise<string>;
  ledger(): Promise<string>;
}>): Promise<Response> => {
  const reply = (body: object, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...DASHBOARD_OVERVIEW_HEADERS, ...extra } });
  if (!input.enabled) return reply({ error: 'not_found' }, 404);
  if (input.request.method === 'GET') return input.limited('read') ?? reply({ version: 1, csrf: input.csrf, commands: CONSOLE_HARNESS_COMMANDS });
  if (input.request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
  let form: FormData;
  try { form = await input.request.formData(); } catch { return reply({ error: 'invalid_request' }, 400); }
  if (form.get('csrf') !== input.csrf) return reply({ error: 'forbidden' }, 403);
  const text = String(form.get('command') ?? '').trim();
  const parsed = text === '/ledger' ? null : parseHarnessCommand(text);
  // A /fire naming no job only answers its usage line, so it spends a read.
  const budget = text === '/ledger' ? 'read' : parsed ? (parsed.kind === 'fire' && parsed.target === null ? 'read' : IN_CONSOLE[parsed.kind]) : null;
  if (budget === null) return reply({ error: 'invalid_command' }, 400);
  const limited = input.limited(budget);
  if (limited) return limited;
  try {
    return reply({ output: (parsed ? await input.run(parsed as ConsoleHarnessCommand) : await input.ledger()).slice(0, HARNESS_MESSAGE_LIMIT) });
  } catch (error) {
    console.error(JSON.stringify({ hop: 'console_harness', ok: false, code: 'command_failed', error_class: error instanceof Error ? error.name : 'unknown' }));
    return reply({ error: 'unavailable' }, 503);
  }
};
