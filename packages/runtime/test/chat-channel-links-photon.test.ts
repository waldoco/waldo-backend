// The first run's iMessage step with Photon configured: each owner texts their own assigned Waldo number, never the shared
// address, and an owner who has no number yet is not offered iMessage until they enroll in the console. The bindings are the
// fictional ones vitest.imessage-photon.config.ts uses, laid over this pool's own so the real number view and directory client
// run against the fixture directory.
import { env as poolEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatChannelLinks } from '../src/channels/chat-channel-links';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000';
const ASSIGNED = '+16285550101', CODE = 'ABCDEFGHJK';
const env = {
  ...poolEnv, WALDO_ENVIRONMENT: 'test', SUPABASE_PROJECT_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: 'fictional-imessage-publishable', WALDO_ROUTER_HMAC_SECRET: SECRET,
  IMESSAGE_CONNECTOR_ENABLED: '1',
  IMESSAGE_CONNECTOR_POLICY: '{"signatureMaxAgeMs":60000,"heartbeatMaxAgeMs":90000,"capabilityMaxAgeMs":90000,"maxRequestBytes":131072,"maxRetainedBytes":16777216,"maxRecords":4096,"pullMaxWaitMs":0,"deliveryDeadlineMs":20000,"mutationDeadlineMs":30000,"commitmentMaxAgeMs":30000,"setupLifetimeMs":600000,"replyHandoffMaxAgeMs":600000,"source":"handoff-2026-10-10-proposed-local-test-profile"}',
  IMESSAGE_CREDENTIAL_WRAPPING_KEY: 'f'.repeat(64), IMESSAGE_WALDO_ADDRESS: 'waldo@fixture.invalid',
  PHOTON_PROJECT_ID: 'proj-fixture', PHOTON_OAUTH_CLIENT_ID: 'client-fixture', PHOTON_OAUTH_CLIENT_SECRET: 'fictional-photon-client-secret',
};
afterEach(() => { vi.restoreAllMocks(); });

const world = () => {
  const id = crypto.randomUUID().slice(0, 8);
  const owners: FixtureOwner[] = [
    { do_name: `links-enrolled-${id}`, owner_id: '61000000-0000-4000-8000-000000000001', state: 'active', state_version: 1, admission_revision: 1, email: 'enrolled@example.invalid', phone: '+15550000021' },
    { do_name: `links-new-${id}`, owner_id: '61000000-0000-4000-8000-000000000002', state: 'active', state_version: 1, admission_revision: 1, email: 'new@example.invalid' },
  ];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners });
  fx.enrollments.set(owners[0]!.do_name, { environment: 'test', phone: '+15550000021', photon_user_id: 'user-1', assigned_number: ASSIGNED, photon_created: true });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    throw new Error(`forbidden egress ${String(input instanceof Request ? input.url : input)}`);
  });
  const auth = { issueLinkCode: vi.fn(async () => CODE), issueProviderLinkCode: vi.fn(async () => CODE), iMessageHandleHint: vi.fn(async () => null), whatsAppHandleHint: vi.fn(async () => null) };
  const links = (doName: string) => chatChannelLinks({ env, kv: { get: () => undefined }, doName, auth: auth as never });
  return { enrolled: links(owners[0]!.do_name), unenrolled: links(owners[1]!.do_name), auth };
};

describe('iMessage link step with Photon', () => {
  it("gives an enrolled owner their own Photon number to text, not the shared address", async () => {
    const { enrolled } = world();
    expect(env.IMESSAGE_WALDO_ADDRESS).toBe('waldo@fixture.invalid');
    expect(await enrolled.offered('imessage')).toBe(true);
    expect(await enrolled.issue('imessage')).toEqual({
      provider: 'imessage', code: CODE, text: `waldo ${CODE}`, address: ASSIGNED, send_url: `sms:${ASSIGNED}&body=waldo%20${CODE}`, expires_in_seconds: 600,
    });
  });
  it('does not offer iMessage to an owner with no Photon number yet, and issues no code', async () => {
    const { unenrolled, auth } = world();
    expect(await unenrolled.offered('imessage')).toBe(false);
    expect(await unenrolled.issue('imessage')).toBeNull();
    expect(auth.issueProviderLinkCode).not.toHaveBeenCalled();
  });
  it('offers nothing when the directory cannot say which number the owner has', async () => {
    const { enrolled } = world();
    vi.mocked(globalThis.fetch).mockImplementation(async () => { throw new Error('directory down'); });
    expect(await enrolled.offered('imessage')).toBe(false);
    expect(await enrolled.issue('imessage')).toBeNull();
  });
});
