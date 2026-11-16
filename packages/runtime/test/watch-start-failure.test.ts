import { describe, expect, it } from 'vitest';
import { watchStartFailure } from '../src/channels/watch-start-failure';
import { GoogleError, GoogleTokenError } from '../src/connectors/google';
import { GooglePushError } from '../src/connectors/google-push';

// Every failed push start names one closed reason, whichever rail it took: a token minted here (GooglePushError) or the
// connector-proxy edge (GoogleError carrying the edge's closed message).
describe('the reason a push start failed', () => {
  it.each([
    [new GooglePushError(400, 'unsupported'), 'unsupported'],
    [new GooglePushError(401, 'auth'), 'google_auth'],
    [new GooglePushError(403, 'refused'), 'google_refused'],
    [new GooglePushError(503, 'transient'), 'google_transient'],
    [new GooglePushError(502, 'malformed'), 'reply_malformed'],
    [new GooglePushError(400, 'invalid_request'), 'invalid_request'],
    [new GoogleError(400, 'google_push_unsupported'), 'unsupported'],
    [new GoogleError(401, 'google_push_auth'), 'google_auth'],
    [new GoogleError(400, 'google_push_refused'), 'google_refused'],
    [new GoogleError(502, 'google_push_transient'), 'google_transient'],
    [new GoogleError(502, 'google_push_malformed'), 'reply_malformed'],
    [new GoogleError(400, 'google_push_invalid_request'), 'invalid_request'],
    [new GoogleError(401, 'google_refresh_failed'), 'token_refresh'],
    [new GoogleTokenError('auth'), 'token_refresh'],
    [new GoogleError(403, 'insufficient scopes'), 'scope'],
    [new GoogleError(401, 'connection unavailable'), 'connection_unavailable'],
    [new GoogleError(404, 'unknown operation'), 'edge_unsupported'],
    [new GoogleError(502, 'connector proxy failed'), 'edge_failed'],
    [new TypeError('fetch failed'), 'edge_failed'],
    [new Error('PRIVATE_CANARY anything else'), 'unknown'],
    ['a thrown string', 'unknown'],
  ] as const)('%s reads as %s', (error, reason) => {
    expect(watchStartFailure(error)).toBe(reason);
  });
});
