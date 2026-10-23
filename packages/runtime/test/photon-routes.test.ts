import { describe, expect, it } from 'vitest';
import { photonCallback } from '../src/channels/imessage/photon-routes';
import { PHOTON_ATTEMPT_TTL_MS, PHOTON_CALLBACK_PATH } from '../src/channels/imessage/photon';
import { bindBrowser } from '../src/connectors/oauth-browser-binding';
import { setCookies } from './support/cookie-jar';
import { forgedBinding } from './support/forged-binding';

const STATE_SECRET = 'fictional-oauth-state-secret';
const NONCE = 'P'.repeat(43);
// No Photon configuration: a callback that gets past the binding reaches the finish step, which fails.
const ENV = { WALDO_OAUTH_STATE_SECRET: STATE_SECRET } as never;
const callback = (cookie: string | null, env: unknown = ENV) =>
  photonCallback(new Request(`https://waldo.example${PHOTON_CALLBACK_PATH}?code=c&state=${NONCE}`, cookie ? { headers: { cookie } } : {}), env as never);

describe('the Photon callback is bound to the browser that started the connect', () => {
  it('goes on only for the binding the start minted under the state secret', async () => {
    const minted = (await bindBrowser(STATE_SECRET, 'photon', NONCE, PHOTON_CALLBACK_PATH, PHOTON_ATTEMPT_TTL_MS, Date.now())).split(';')[0]!;
    expect((await callback(minted)).status).not.toBe(403);
  });

  it('refuses a binding built from the authorize address alone', async () => {
    const response = await callback(await forgedBinding('photon', NONCE));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(STATE_SECRET);
  });

  it('runs no callback without the state secret', async () => {
    const minted = (await bindBrowser(STATE_SECRET, 'photon', NONCE, PHOTON_CALLBACK_PATH, PHOTON_ATTEMPT_TTL_MS, Date.now())).split(';')[0]!;
    const response = await callback(minted, {});
    expect([response.status, setCookies(response), await response.text()]).toEqual([404, [], 'not found']);
  });
});
