import { describe, expect, it, vi } from 'vitest';
import { gatedCaller } from '../src/channels/telegram-api';
import { renderConsole } from '../src/channels/console';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';
import { consoleAuth } from '../src/identity/console-auth';
import { routerSignature } from '../src/identity/owner-directory';

describe('Telegram unlink', () => {
  it('drops every send once unlinked, so a queued reminder cannot reach the old chat', async () => {
    let unlinked = false;
    const call = vi.fn().mockResolvedValue({ message_id: 1 });
    const gated = gatedCaller(call, () => unlinked);
    await gated('sendMessage', { chat_id: 1, text: 'before' });
    unlinked = true;
    expect(await gated('sendMessage', { chat_id: 1, text: 'reminder' })).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('signs the unlink for this owner only', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('true'));
    const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
    expect(await consoleAuth(env, fetcher as unknown as typeof fetch, () => 1_790_000_000_000)!.unlinkTelegram('do-a')).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://db.test/rest/v1/rpc/unlink_presence');
    expect(JSON.parse(String(init.body))).toEqual({ p_do_name: 'do-a', p_provider: 'telegram', p_at: 1_790_000_000, p_sig: await routerSignature('router', 1_790_000_000, 'unlink.do-a.telegram') });
  });

  it('offers Unlink only while linked and when account sign-in exists to link again', () => {
    expect(renderConsole(SAMPLE_CONSOLE_VIEW)).toContain('value="telegram.unlink"');
    expect(renderConsole({ ...SAMPLE_CONSOLE_VIEW, telegram: { linked: false, unlinkAvailable: true } })).not.toContain('value="telegram.unlink"');
    expect(renderConsole({ ...SAMPLE_CONSOLE_VIEW, telegram: { linked: true, unlinkAvailable: false } })).not.toContain('value="telegram.unlink"');
  });
});
