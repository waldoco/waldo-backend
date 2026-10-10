import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { iMessageComposition } from '../src/channels/imessage/bridge-do';
import { handleIMessageHost } from '../src/channels/imessage/http';
import { PROPOSED_LOCAL_TEST_POLICY, parseIMessageConnectorPolicy } from '../src/channels/imessage/policy';

it('the suite config pins exactly the proposed local test policy', () => {
  expect(JSON.parse(String(env.IMESSAGE_CONNECTOR_POLICY))).toEqual(PROPOSED_LOCAL_TEST_POLICY);
});

it('policy has no hidden defaults: missing, partial or inconsistent policies are refused', () => {
  expect(parseIMessageConnectorPolicy(undefined)).toBeNull();
  const { source: _s, ...missing } = PROPOSED_LOCAL_TEST_POLICY;
  expect(parseIMessageConnectorPolicy(missing)).toBeNull();
  expect(parseIMessageConnectorPolicy({ ...PROPOSED_LOCAL_TEST_POLICY, deliveryDeadlineMs: 40_000 })).toBeNull();
  expect(parseIMessageConnectorPolicy({ ...PROPOSED_LOCAL_TEST_POLICY, extra: 1 })).toBeNull();
});

it('every missing composition piece disables the connector; disabled routes do not exist', async () => {
  const base = env as unknown as Record<string, unknown>;
  expect(iMessageComposition(base as never)).not.toBeNull();
  for (const missing of ['IMESSAGE_CONNECTOR_ENABLED', 'IMESSAGE_CONNECTOR_POLICY', 'IMESSAGE_CREDENTIAL_WRAPPING_KEY', 'IMESSAGE_BRIDGE_DO', 'TELEGRAM_OWNER_DO', 'SUPABASE_PROJECT_URL', 'WALDO_ROUTER_HMAC_SECRET', 'WALDO_ENVIRONMENT']) {
    const partial = { ...base, [missing]: undefined };
    expect(iMessageComposition(partial as never), missing).toBeNull();
    const response = await handleIMessageHost(new Request('https://fixture.invalid/channels/imessage/v1/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), partial as never);
    expect(response.status, missing).toBe(404);
  }
  expect(iMessageComposition({ ...base, IMESSAGE_CONNECTOR_ENABLED: '0' } as never)).toBeNull();
  expect(iMessageComposition({ ...base, IMESSAGE_CREDENTIAL_WRAPPING_KEY: 'short' } as never)).toBeNull();
});
