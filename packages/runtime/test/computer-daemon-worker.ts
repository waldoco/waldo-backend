import { DurableObject } from 'cloudflare:workers';

/** Local SQLite storage only; this Worker is never deployed. */
export class ComputerDaemonStorage extends DurableObject {}
export default { fetch: () => new Response('Not found', { status: 404 }) };
