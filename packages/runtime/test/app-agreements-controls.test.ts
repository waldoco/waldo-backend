// The app's agreements view on the one controls path: GET /app/v1/controls?view=agreements reads Improve Waldo for
// everyone, and POST /app/v1/actions gives or withdraws it through the control-action receipt book.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { APP_CONTROLS_AGREEMENTS_REVISION, APP_IMPROVE_WALDO_AGREEMENT_V1, APP_IMPROVE_WALDO_RECEIPTS_V1, appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { appControlsRequest, type AppControlsHost } from '../src/channels/app-controls';
import { improveWaldoGiven } from '../src/channels/agreements';

const VERSION = APP_IMPROVE_WALDO_AGREEMENT_V1.version;
const unused = () => { throw Error('The agreements view reads the owner object only'); };
type Call = Promise<{ status: number; body: Record<string, unknown> }>;
const app = (run: (o: { read(): Call; act(body: Record<string, unknown>): Call; storage: DurableObjectState['storage'] }) => Promise<void>, revision = APP_CONTROLS_AGREEMENTS_REVISION) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`app-agreements-${crypto.randomUUID()}`)), async (_i, state) => {
    const host: AppControlsHost = { csrf: 'a'.repeat(64), expires: Date.now() + 60_000, signedInAt: new Date().toISOString(), storage: state.storage, assertCurrent: async () => {},
      sessions: async () => [{ csrf: 'a'.repeat(64), expires: Date.now() + 60_000 }], view: unused, act: unused,
      account: { owner: 'owner-app-agreements', auth: null, requestUrl: 'https://app.fixture.invalid/app/v1/controls', purgeOwnerFiles: unused, eraseOwnerStorage: unused },
      phone: {}, whatsappUnlinked: unused };
    const headers = { [APP_CONTRACT_HEADER]: `controls=${revision}` };
    const call = async (request: Request) => { const response = await appControlsRequest(request, host); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
    await run({
      read: () => call(new Request('https://app.fixture.invalid/app/v1/controls?view=agreements', { headers })),
      act: (body) => call(new Request('https://app.fixture.invalid/app/v1/actions', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })),
      storage: state.storage,
    });
  });
const receipt = (body: Record<string, unknown>) => appControlResultV1Schema.parse(body).receipt;
const improve = (value: string, revision: unknown, request_id: string, notice: string = VERSION) => ({ view: 'agreements', action: 'improve_waldo.set', value, notice, revision, request_id });

it('is off until the owner gives it, then gives, withdraws and records each choice with receipts the app can read back', async () => {
  await app(async ({ read, act, storage }) => {
    const first = await read();
    expect(first.status).toBe(200);
    expect(appControlProjectionV1Schema.parse(first.body)).toMatchObject({ view: 'agreements', data: { improve_waldo: { given: false, version: VERSION, changed_at: null }, actions: ['improve_waldo.set'] } });

    expect(receipt((await act(improve('withdrawn', first.body.revision, 'agree-0001'))).body)).toEqual(APP_IMPROVE_WALDO_RECEIPTS_V1.already_withdrawn);
    expect(storage.kv.get('agreement:improve_waldo:history')).toBeUndefined();

    const given = await act(improve('given', first.body.revision, 'agree-0002'));
    expect([given.status, receipt(given.body)]).toEqual([200, APP_IMPROVE_WALDO_RECEIPTS_V1.given]);
    const replay = await act(improve('given', first.body.revision, 'agree-0002'));
    expect([replay.body.duplicate, receipt(replay.body)]).toEqual([true, APP_IMPROVE_WALDO_RECEIPTS_V1.given]);
    expect(improveWaldoGiven(storage.kv)).toBe(true);

    const after = await read();
    expect(after.body).toMatchObject({ data: { improve_waldo: { given: true, version: VERSION, changed_at: expect.any(Number) } } });
    expect((await act(improve('withdrawn', first.body.revision, 'agree-0003'))).body).toMatchObject({ error: 'stale_read' });
    expect(receipt((await act(improve('given', after.body.revision, 'agree-0004'))).body)).toEqual(APP_IMPROVE_WALDO_RECEIPTS_V1.already_given);
    expect(receipt((await act(improve('withdrawn', after.body.revision, 'agree-0005'))).body)).toEqual(APP_IMPROVE_WALDO_RECEIPTS_V1.withdrawn);
    expect(improveWaldoGiven(storage.kv)).toBe(false);
    expect(storage.kv.get('agreement:improve_waldo:history')).toEqual([{ given: true, version: VERSION, at: expect.any(Number) }, { given: false, version: VERSION, at: expect.any(Number) }]);
  });
});

it('refuses a choice made against other wording, and reads a choice given under an older version as not given', async () => {
  await app(async ({ read, act, storage }) => {
    const first = await read();
    const stale = await act(improve('given', first.body.revision, 'agree-0101', '2025-01-01'));
    expect([stale.status, receipt(stale.body)]).toEqual([409, APP_IMPROVE_WALDO_RECEIPTS_V1.notice_stale]);
    expect(improveWaldoGiven(storage.kv)).toBe(false);
    storage.kv.put('agreement:improve_waldo', { given: true, version: '2025-01-01', at: 1_700_000_000_000 });
    expect((await read()).body).toMatchObject({ data: { improve_waldo: { given: false, version: VERSION, changed_at: 1_700_000_000_000 } } });
  });
});

it('is neither read nor changed by a build below revision 18', async () => {
  await app(async ({ read, act, storage }) => {
    expect((await read()).status).toBe(400);
    expect((await act(improve('given', 'f'.repeat(64), 'agree-0201'))).status).toBe(400);
    expect(improveWaldoGiven(storage.kv)).toBe(false);
  }, APP_CONTROLS_AGREEMENTS_REVISION - 1);
});

it('refuses an action that is not well formed', async () => {
  await app(async ({ read, act }) => {
    const { revision } = (await read()).body;
    for (const body of [{ ...improve('yes', revision, 'agree-0301') }, { ...improve('given', revision, 'agree-0302'), view: 'account' }, { ...improve('given', revision, 'agree-0303'), notice: undefined }, { ...improve('given', revision, 'agree-0304'), id: 'x' }]) {
      expect((await act(body)).status).toBe(400);
    }
  });
});
