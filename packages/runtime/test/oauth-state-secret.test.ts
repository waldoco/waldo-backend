import { describe, expect, it, vi } from 'vitest';
import { oauthStateSecret } from '../src/connectors/oauth-state-secret';

describe('the connector OAuth state key', () => {
  it('is its own secret, never another one, and its absence is logged once per isolate', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(oauthStateSecret({ WALDO_OAUTH_STATE_SECRET: 'state-key-fixture' })).toBe('state-key-fixture');
    expect(warn).not.toHaveBeenCalled();
    expect(oauthStateSecret({ TELEGRAM_WEBHOOK_SECRET: 'telegram-fixture' } as never)).toBeNull();
    expect(oauthStateSecret({})).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({ event: 'oauth_state_secret_missing', effect: 'google_and_mcp_sign_in_off' });
    warn.mockRestore();
  });
});
