import { routerSignature } from './owner-directory';

export type ConsoleTicket = Readonly<{ owner: string; token: string; expires: number }>;
const encode = (value: string) => btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

// The envelope selects an issuer; only the issuer's live, single-use DO grant admits a session.
export const signConsoleTicket = async (ticket: ConsoleTicket, secret: string): Promise<string> => {
  const payload = encode(JSON.stringify(ticket));
  return `c1.${payload}.${await routerSignature(secret, 0, `console-ticket.${payload}`)}`;
};

export const readConsoleTicket = async (value: string, secret: string, now = Date.now()): Promise<ConsoleTicket | null> => {
  if (value.length > 2048) return null;
  const match = /^c1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(value);
  if (!match) return null;
  const expected = await routerSignature(secret, 0, `console-ticket.${match[1]}`);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ match[2]!.charCodeAt(i);
  if (diff) return null;
  try {
    const ticket = JSON.parse(atob(match[1]!.replaceAll('-', '+').replaceAll('_', '/'))) as ConsoleTicket;
    return typeof ticket.owner === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ticket.owner)
      && typeof ticket.token === 'string' && /^[a-f0-9]{64}$/.test(ticket.token)
      && Number.isSafeInteger(ticket.expires) && ticket.expires >= now ? ticket : null;
  } catch { return null; }
};
