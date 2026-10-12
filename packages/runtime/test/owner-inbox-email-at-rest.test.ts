// The verified owner email must not rest in the DO inbox when text capture is off or the environment is production.
// Runs under the default test config (wrangler defaults: production, capture off); the env is also overridden per case.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { OWNER_TRACE_HEADER } from '../src/observability/owner-trace-identity';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const SUBJECT = '81201';
const IDENTITY = { owner_id: '10000000-0000-0000-0000-0000000000aa', owner_email: 'at-rest@test.invalid' };

const admit = async (name: string, vars: Record<string, string>) => {
  let stored = '';
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const instance = new TelegramOwnerDO(state, {
      ...env, ...vars, TELEGRAM_BOT_TOKEN: '123456:fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-inbox-secret', OPENAI_API_KEY: 'fictional-model-key',
    });
    // Admission only; the drain is not the subject here.
    vi.spyOn(instance as unknown as { drainInbox(): Promise<void> }, 'drainInbox').mockResolvedValue(undefined);
    const response = await instance.fetch(new Request('https://telegram-owner/enqueue', {
      method: 'POST',
      headers: {
        'x-waldo-inbox-secret': 'fictional-inbox-secret', 'x-waldo-telegram-subject': SUBJECT, 'x-waldo-do-name': name,
        [OWNER_TRACE_HEADER]: encodeURIComponent(JSON.stringify(IDENTITY)),
      },
      body: JSON.stringify({ update_id: 7001, message: { message_id: 1, date: 1, from: { id: Number(SUBJECT), is_bot: false, first_name: 'T' }, chat: { id: Number(SUBJECT), type: 'private' }, text: 'Synthetic hello' } }),
    }));
    expect(response.status).toBe(200);
    stored = JSON.stringify(state.storage.kv.get('telegram_owner_inbox_v1'));
    await state.storage.deleteAlarm();
  });
  return stored;
};

describe('verified owner email in the inbox record', () => {
  it('is not stored in production (owner_id still is)', async () => {
    const stored = await admit('inbox-email-production', { WALDO_ENVIRONMENT: 'production', LANGFUSE_CAPTURE_TEXT: 'true' });
    expect(stored).toContain(IDENTITY.owner_id);
    expect(stored).not.toContain(IDENTITY.owner_email);
  });
  it('is not stored when capture is off', async () => {
    const stored = await admit('inbox-email-capture-off', { WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'false' });
    expect(stored).toContain(IDENTITY.owner_id);
    expect(stored).not.toContain(IDENTITY.owner_email);
  });
  it('is stored on staging with capture on (the case the others are measured against)', async () => {
    const stored = await admit('inbox-email-staging', { WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'true' });
    expect(stored).toContain(IDENTITY.owner_email);
  });
});
