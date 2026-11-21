import { GoogleError, GoogleTokenError } from '../connectors/google';
import { GooglePushError } from '../connectors/google-push';

// Why one Calendar channel or Gmail watch did not start, as one word from a closed set, whichever rail started it: a token
// minted here throws GooglePushError, the connector-proxy edge answers with one of its own closed messages. The set is what
// the logs carry, so a failed start is never silent and never carries the account, the calendar, or Google's own text.
export const WATCH_START_FAILURES = ['unsupported', 'google_auth', 'google_refused', 'google_transient', 'reply_malformed', 'invalid_request',
  'token_refresh', 'scope', 'connection_unavailable', 'edge_unsupported', 'edge_failed', 'route_failed', 'unknown'] as const;
export type WatchStartFailure = typeof WATCH_START_FAILURES[number];

const PUSH: Readonly<Record<GooglePushError['code'], WatchStartFailure>> = {
  unsupported: 'unsupported', auth: 'google_auth', refused: 'google_refused', transient: 'google_transient', malformed: 'reply_malformed', invalid_request: 'invalid_request',
};
const EDGE: Readonly<Record<string, WatchStartFailure>> = {
  ...Object.fromEntries(Object.entries(PUSH).map(([code, reason]) => [`google_push_${code}`, reason])),
  google_refresh_failed: 'token_refresh', 'insufficient scopes': 'scope', 'connection unavailable': 'connection_unavailable',
  'unknown operation': 'edge_unsupported', 'connector proxy failed': 'edge_failed',
};

export const watchStartFailure = (error: unknown): WatchStartFailure =>
  error instanceof GooglePushError ? PUSH[error.code]
    : error instanceof GoogleTokenError ? 'token_refresh'
      : error instanceof GoogleError ? EDGE[error.message] ?? 'unknown'
        // The edge was not reached: fetch rejects with a TypeError.
        : error instanceof TypeError ? 'edge_failed' : 'unknown';
