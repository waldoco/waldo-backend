import { describe, expect, it } from 'vitest';
import { googleClientPath } from '../src/connectors/google-account-path';

describe('google send-path custody gate', () => {
  const local = { refresh_token: 'rt-local' };
  const linked = {};

  it('an existing local-token account sending with a proxy migrates into Vault custody (adopt)', () => {
    expect(googleClientPath(local, 'email_send:prop-1', true)).toEqual({ kind: 'adopt' });
  });

  it('an existing local-token account sending with NO proxy is refused - never a direct send outside the idempotency gate', () => {
    expect(googleClientPath(local, 'email_send:prop-1', false)).toEqual({ kind: 'reject_send' });
  });

  it('reads keep the local-token fallback when no proxy is configured', () => {
    expect(googleClientPath(local, undefined, false)).toEqual({ kind: 'direct' });
    expect(googleClientPath(local, undefined, true)).toEqual({ kind: 'direct' });
  });

  it('a connection-id account sends through the proxy; without a proxy it is simply unavailable', () => {
    expect(googleClientPath(linked, 'email_send:prop-1', true)).toEqual({ kind: 'vault' });
    expect(googleClientPath(linked, 'email_send:prop-1', false)).toEqual({ kind: 'unavailable' });
    expect(googleClientPath(linked, undefined, true)).toEqual({ kind: 'vault' });
    expect(googleClientPath(linked, undefined, false)).toEqual({ kind: 'unavailable' });
  });
});
