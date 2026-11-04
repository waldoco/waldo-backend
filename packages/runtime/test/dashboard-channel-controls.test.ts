import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';

// This pool runs with the iMessage connector off and no owner directory configured.
const root = 'https://telegram-owner';
const open = async (name: string, runtime = false) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const token = await runInDurableObject(stub, (instance, state) => {
    if (runtime) Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
    state.storage.kv.put('do_name', name); return consoleAccess(state.storage).grant();
  });
  const headers = { cookie: 'waldo_console=' + token, accept: 'application/json' };
  const read = (query: string) => stub.fetch(root + CONTROLS_PATH + query, { headers });
  const post = (fields: Record<string, string>) => stub.fetch(root + CONTROL_ACTION_PATH, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  return { read, post };
};

describe('iMessage and device controls on a server without them', () => {
  it('shows iMessage as not enabled, with nothing to act on', async () => {
    const { read, post } = await open('channel-controls-disabled');
    const response = await read('?view=imessage');
    expect(response.status).toBe(200);
    const body = await response.json() as { csrf: string; revision: string; data: unknown; status: unknown };
    expect(body).toMatchObject({ version: 1, view: 'imessage', state: 'available', data: { enabled: false, address: null, linked_hint: null, admin: false, actions: [], bridges: [] }, status: { bridges: [] } });
    const refused = await post({ csrf: body.csrf, revision: body.revision, view: 'imessage', action: 'imessage.pair', request_id: 'disabled-pair-0001' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'no_longer_eligible' });
  });
  it('reads an unreachable device directory as unavailable, never as no devices', async () => {
    const { read, post } = await open('channel-controls-no-directory');
    const response = await read('?view=devices');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'controls_unavailable' });
    const csrf = (await (await read('?view=imessage')).json() as { csrf: string }).csrf;
    const refused = await post({ csrf, revision: 'f'.repeat(64), view: 'devices', action: 'device.pair', request_id: 'no-directory-0001' });
    expect(refused.status).toBe(503);
  });
  it('treats only a read that names the view alone as an iMessage or device read', async () => {
    const { read } = await open('channel-controls-query', true);
    for (const query of ['?view=imessage&view=devices', '?view=imessage&id=x', '?view=Devices']) expect((await read(query)).status).toBe(400);
  });
});
