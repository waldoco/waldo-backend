import { HARNESS_MESSAGE_LIMIT } from '../memory/held-rows';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { parseHarnessCommand, type HarnessCommand } from './harness';

export const DASHBOARD_HARNESS_PATH = '/console/dashboard/api/v1/harness';

type ConsoleCommand = Exclude<HarnessCommand, Readonly<{ kind: 'console' }>>;
// Which commands the console runs, and which budget each spends: a fire runs a job, the rest read. /console is the page
// itself, so it is not one.
const IN_CONSOLE: Record<HarnessCommand['kind'], 'read' | 'action' | null> = { fire: 'action', trace: 'read', e2e: 'read', console: null, usage: 'read', langfuse: 'read', heldrows: 'read' };

// The operator commands Telegram took, for the owner in the console (CONSOLE_HARNESS): the same handlers, run as the
// signed-in owner behind the console's session, CSRF token and rate budget. /stop has its own homes (a message's stop and
// WhatsApp's /stop) and is no command here.
export const consoleHarness = async (input: Readonly<{
  request: Request; csrf: string; enabled: boolean;
  limited(kind: 'read' | 'action'): Response | null;
  run(command: ConsoleCommand): Promise<string>;
  ledger(): Promise<string>;
}>): Promise<Response> => {
  const reply = (body: object, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...DASHBOARD_OVERVIEW_HEADERS, ...extra } });
  if (!input.enabled) return reply({ error: 'not_found' }, 404);
  if (input.request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  let form: FormData;
  try { form = await input.request.formData(); } catch { return reply({ error: 'invalid_request' }, 400); }
  if (form.get('csrf') !== input.csrf) return reply({ error: 'forbidden' }, 403);
  const text = String(form.get('command') ?? '').trim();
  const parsed = text === '/ledger' ? null : parseHarnessCommand(text);
  const budget = text === '/ledger' ? 'read' : parsed ? IN_CONSOLE[parsed.kind] : null;
  if (budget === null) return reply({ error: 'invalid_command' }, 400);
  const limited = input.limited(budget);
  if (limited) return limited;
  try {
    return reply({ output: (parsed ? await input.run(parsed as ConsoleCommand) : await input.ledger()).slice(0, HARNESS_MESSAGE_LIMIT) });
  } catch {
    console.error(JSON.stringify({ hop: 'console_harness', ok: false, code: 'command_failed' }));
    return reply({ error: 'unavailable' }, 503);
  }
};
