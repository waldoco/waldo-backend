// The verified owner email must not rest in the DO inbox when text capture is off for this owner (not agreed to diagnostic
// recording, or the answer is unavailable) or the environment is production.
// Runs under the default test config (wrangler defaults: production, capture off); the env is also overridden per case.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { OWNER_TRACE_HEADER } from '../src/observability/owner-trace-identity';
import { DIAGNOSTIC_RECORDING_WORDING } from '../src/identity/diagnostic-recording';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const SUBJECT = '81201';
const IDENTITY = { owner_id: '10000000-0000-0000-0000-0000000000aa', owner_email: 'at-rest@test.invalid' };

const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
// The directory's answer about diagnostic recording for this owner: agreed, declined, or unreachable.
const admit = async (name: string, vars: Record<string, string>, recording: 'agreed' | 'declined' | 'outage' = 'agreed') => {
  let stored = '';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (!String(input).endsWith('/rpc/diagnostic_recording_state') || recording === 'outage') return new Response('unavailable', { status: 503 });
    return Response.json(recording === 'agreed' ? { agreed: true, version: DIAGNOSTIC_RECORDING_WORDING.version, agreed_at: '2026-10-22T09:00:00.000Z' } : { agreed: false, version: null, agreed_at: null });
  });
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const instance = new OwnerDO(state, {
      ...env, ...directory, ...vars, TELEGRAM_BOT_TOKEN: '123456:fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-inbox-secret', OPENAI_API_KEY: 'fictional-model-key',
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
  vi.unstubAllGlobals();
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
  it.each(['declined', 'outage'] as const)('is not stored on staging when the owner\'s diagnostic recording answer is %s', async recording => {
    const stored = await admit(`inbox-email-${recording}`, { WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'true' }, recording);
    expect(stored).toContain(IDENTITY.owner_id);
    expect(stored).not.toContain(IDENTITY.owner_email);
  });
  it('is stored on staging with capture on for an owner who agreed (the case the others are measured against)', async () => {
    const stored = await admit('inbox-email-staging', { WALDO_ENVIRONMENT: 'staging', LANGFUSE_CAPTURE_TEXT: 'true' });
    expect(stored).toContain(IDENTITY.owner_email);
  });
});
