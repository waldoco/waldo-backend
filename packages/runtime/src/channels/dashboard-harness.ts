import { HARNESS_MESSAGE_LIMIT } from '../memory/held-rows';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { parseHarnessCommand, type HarnessCommand } from './harness';

export const DASHBOARD_HARNESS_PATH = '/console/dashboard/api/v1/harness';

// The operator commands Telegram took, for the owner in the console (CONSOLE_HARNESS): the same handlers, run as the
// signed-in owner behind the console's session, CSRF token and rate budget. A fire runs a job, so it spends the action budget;
// the rest read. /console and /stop have their own homes (the console itself; a message's stop and WhatsApp's /stop).
export const consoleHarness = async (input: Readonly<{
  request: Request; csrf: string; enabled: boolean;
  limited(kind: 'read' | 'action'): Response | null;
  run(command: Exclude<HarnessCommand, Readonly<{ kind: 'console' }>>): Promise<string>;
  ledger(): Promise<string>;
}>): Promise<Response> => {
  const reply = (body: object, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...DASHBOARD_OVERVIEW_HEADERS, ...extra } });
  if (!input.enabled) return reply({ error: 'not_found' }, 404);
  if (input.request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  let form: FormData;
  try { form = await input.request.formData(); } catch { return reply({ error: 'invalid_request' }, 400); }
  if (form.get('csrf') !== input.csrf) return reply({ error: 'forbidden' }, 403);
  const text = String(form.get('command') ?? '').trim();
  const command = text === '/ledger' ? 'ledger' as const : parseHarnessCommand(text);
  if (command === null || (command !== 'ledger' && command.kind === 'console')) return reply({ error: 'invalid_command' }, 400);
  const limited = input.limited(command !== 'ledger' && command.kind === 'fire' ? 'action' : 'read');
  if (limited) return limited;
  try {
    return reply({ output: (command === 'ledger' ? await input.ledger() : await input.run(command)).slice(0, HARNESS_MESSAGE_LIMIT) });
  } catch {
    console.error(JSON.stringify({ hop: 'console_harness', ok: false, code: 'command_failed' }));
    return reply({ error: 'unavailable' }, 503);
  }
};
