import { describe, expect, it } from 'vitest';
import { GoogleError, googleClient, googleErrorReason } from '../src/connectors/google';

// Issue #668. Structured provider evidence only; message text is never parsed.
const info = (reason: string, domain = 'googleapis.com') => ({ error: { code: 403, message: 'm', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain }] } });
describe('googleErrorReason', () => {
  it('reads ErrorInfo and legacy reasons, nothing else', () => {
    expect(googleErrorReason(info('ACCESS_TOKEN_SCOPE_INSUFFICIENT'))).toBe('ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    expect(googleErrorReason(info('SERVICE_DISABLED'))).toBe('SERVICE_DISABLED');
    expect(googleErrorReason({ error: { errors: [{ reason: 'insufficientPermissions' }] } })).toBe('ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    expect(googleErrorReason({ error: { errors: [{ reason: 'accessNotConfigured' }] } })).toBe('SERVICE_DISABLED');
  });
  it('ignores message text, foreign domains, unknown reasons and malformed bodies', () => {
    expect(googleErrorReason({ error: { message: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT SERVICE_DISABLED' } })).toBeUndefined();
    expect(googleErrorReason(info('SERVICE_DISABLED', 'evil.example'))).toBeUndefined();
    expect(googleErrorReason(info('RATE_LIMIT_EXCEEDED'))).toBeUndefined();
    for (const bad of [null, 'x', 7, [], { error: 'x' }, { error: { details: 'x', errors: 'y' } }]) expect(googleErrorReason(bad)).toBeUndefined();
  });
  it('the REST client carries the reason on the GoogleError it throws', async () => {
    const fetcher = (async (input: RequestInfo | URL) => String(input).startsWith('https://oauth2.googleapis.com/token') ? Response.json({ access_token: 'at' }) : Response.json(info('SERVICE_DISABLED'), { status: 403 })) as typeof fetch;
    const client = googleClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://w.example/cb' }, { refresh_token: 'rt' }, fetcher);
    const error = await client.tasks('todo', 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleError);
    expect(error).toMatchObject({ status: 403, reason: 'SERVICE_DISABLED' });
  });
});
