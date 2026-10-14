import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployedWorker, edgeFunctionFacts, evaluateProbe, main, verdict, versionFacts } from './staging-gate.mjs';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const V3 = '33333333-3333-4333-8333-333333333333';
const deployment = (created_on, versions) => ({ id: created_on, created_on, author_email: 'owner@example.com', versions });

test('current deployment is the newest; rollback target is the newest earlier single version', () => {
  const list = [
    deployment('2026-10-12T00:00:00Z', [{ version_id: V2, percentage: 100 }]),
    deployment('2026-10-13T00:00:00Z', [{ version_id: V3, percentage: 100 }]),
    deployment('2026-10-11T00:00:00Z', [{ version_id: V1, percentage: 100 }]),
  ];
  assert.deepEqual(deployedWorker(list), { versions: [{ id: V3, percentage: 100 }], createdOn: '2026-10-13T00:00:00Z', rollbackTo: V2 });
});

test('a split deployment reports every version and skips its own versions as a rollback target', () => {
  const list = [
    deployment('2026-10-11T00:00:00Z', [{ version_id: V1, percentage: 100 }]),
    deployment('2026-10-12T00:00:00Z', [{ version_id: V2, percentage: 100 }]),
    deployment('2026-10-13T00:00:00Z', [{ version_id: V2, percentage: 90 }, { version_id: V3, percentage: 10 }]),
  ];
  const worker = deployedWorker(list);
  assert.deepEqual(worker.versions, [{ id: V2, percentage: 90 }, { id: V3, percentage: 10 }]);
  assert.equal(worker.rollbackTo, V1);
});

test('a single deployment has no rollback target; malformed output is rejected', () => {
  assert.equal(deployedWorker([deployment('2026-10-13T00:00:00Z', [{ version_id: V1, percentage: 100 }])]).rollbackTo, null);
  for (const bad of [[], {}, null, [{ created_on: 'x', versions: [{ version_id: 'not-a-uuid', percentage: 100 }] }]]) {
    assert.throws(() => deployedWorker(bad), /deployments_shape/);
  }
});

test('version facts carry only the id, stamped release and browser binding presence', () => {
  const version = {
    id: V3, metadata: { created_on: '2026-10-13T00:00:00Z', author_email: 'owner@example.com' },
    resources: { bindings: [
      { type: 'plain_text', name: 'WALDO_RELEASE', text: '929fd79' },
      { type: 'plain_text', name: 'WALDO_OWNER_TELEGRAM_ID', text: '123' },
      { type: 'secret_text', name: 'TELEGRAM_WEBHOOK_SECRET' },
      { type: 'browser', name: 'BROWSER' },
    ] },
  };
  assert.deepEqual(versionFacts(version), { id: V3, release: '929fd79', browser: true });
  assert.deepEqual(versionFacts({ id: V3, resources: { bindings: [] } }), { id: V3, release: null, browser: false });
  assert.throws(() => versionFacts({ id: V3 }), /version_shape/);
});

test('healthz passes only for a stamped release that matches the expected SHA', () => {
  const ok = { status: 200, body: { ok: true, release: '929fd79' } };
  assert.equal(evaluateProbe('healthz', ok).pass, true);
  assert.equal(evaluateProbe('healthz', ok, '929fd79a8c9289aaaaaaaaaaaaaaaaaaaaaaaaaa').pass, true);
  assert.equal(evaluateProbe('healthz', ok, 'a8c9289aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').pass, false);
  assert.equal(evaluateProbe('healthz', { status: 200, body: { ok: true, release: 'unreleased' } }).pass, false);
  assert.equal(evaluateProbe('healthz', { status: 200, body: { ok: true, release: null } }).pass, false);
  assert.equal(evaluateProbe('healthz', { status: 503, body: null }).pass, false);
});

test('webhook ingress must refuse an unsigned call with 403, not 404 (unconfigured) or 2xx', () => {
  for (const name of ['telegram-unsigned', 'gmail-push-unsigned']) {
    assert.equal(evaluateProbe(name, { status: 403, body: null }).pass, true);
    for (const status of [200, 400, 404, 500]) assert.equal(evaluateProbe(name, { status, body: null }).pass, false);
  }
});

test('connector proxy refusal is accepted at the gateway or inside the function, nowhere else', () => {
  assert.equal(evaluateProbe('connector-proxy-unsigned', { status: 401, body: null }).pass, true);
  assert.equal(evaluateProbe('connector-proxy-unsigned', { status: 200, body: { error: { status: 401, message: 'unsigned proxy call' } } }).pass, true);
  assert.equal(evaluateProbe('connector-proxy-unsigned', { status: 200, body: { error: { status: 404, message: 'connector proxy is not configured' } } }).pass, false);
  assert.equal(evaluateProbe('connector-proxy-unsigned', { status: 200, body: { data: null } }).pass, false);
  assert.equal(evaluateProbe('connector-proxy-unsigned', { status: 502, body: null }).pass, false);
});

test('an unknown probe name is a programming error', () => {
  assert.throws(() => evaluateProbe('nope', { status: 200, body: null }), /unknown_probe/);
});

test('verdict: any FAIL fails, otherwise any UNAVAILABLE is incomplete', () => {
  assert.equal(verdict([{ result: 'PASS' }, { result: 'PASS' }]), 'PASS');
  assert.equal(verdict([{ result: 'PASS' }, { result: 'UNAVAILABLE' }]), 'INCOMPLETE');
  assert.equal(verdict([{ result: 'UNAVAILABLE' }, { result: 'FAIL' }]), 'FAIL');
  assert.equal(verdict([]), 'FAIL');
});

test('edge function facts keep only slug, version, status and JWT setting; a missing function is reported', () => {
  const list = [
    { id: 'x', slug: 'connector-proxy', name: 'connector-proxy', version: 42, status: 'ACTIVE', verify_jwt: false, updated_at: 1760400000000, ezbr_sha256: 'ab' },
    { id: 'y', slug: 'other', version: 1, status: 'ACTIVE', verify_jwt: true, updated_at: 1 },
  ];
  assert.deepEqual(edgeFunctionFacts(list, ['connector-proxy', 'mint-agent-jwt']), [
    { slug: 'connector-proxy', version: 42, status: 'ACTIVE', verifyJwt: false, updatedAt: '2025-10-14T00:00:00.000Z' },
    { slug: 'mint-agent-jwt', missing: true },
  ]);
  assert.throws(() => edgeFunctionFacts({}, ['connector-proxy']), /functions_shape/);
  assert.throws(() => edgeFunctionFacts([{ slug: 'connector-proxy', version: 'x' }], ['connector-proxy']), /functions_shape/);
});

test('without credentials the gate probes, prints only allow-listed fields and reports INCOMPLETE', async (t) => {
  const replies = {
    '/healthz': [200, { ok: true, release: '929fd79', secret: 'BODY-CANARY' }],
    '/telegram/webhook': [403, null],
    '/events/gmail': [403, null],
    '/functions/v1/connector-proxy': [200, { error: { status: 401, message: 'unsigned proxy call' } }],
  };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push([new URL(url).pathname, init.method, Object.keys(init.headers ?? {})]);
    const [status, body] = replies[new URL(url).pathname];
    return new Response(body ? JSON.stringify(body) : 'forbidden', { status });
  });
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  assert.equal(await main(['--expect-sha', '929fd79a8c9289'], {}), 2);
  assert.deepEqual(requests.map(([path, method]) => `${method} ${path}`), ['GET /healthz', 'POST /telegram/webhook', 'POST /events/gmail', 'POST /functions/v1/connector-proxy']);
  assert.ok(requests.every(([, , headers]) => headers.every((h) => h === 'content-type')), 'probes carry no credential header');
  assert.deepEqual(lines.filter((l) => /^(PASS|FAIL|UNAVAILABLE) /.test(l)).map((l) => l.split(' |')[0]), [
    'PASS healthz', 'PASS telegram-unsigned', 'PASS gmail-push-unsigned', 'PASS connector-proxy-unsigned', 'UNAVAILABLE worker-version', 'UNAVAILABLE supabase',
  ]);
  assert.ok(!lines.join('\n').includes('BODY-CANARY'));
  assert.equal(lines.at(-1), 'GATE INCOMPLETE');
});

test('an invalid expected SHA is refused before any probe', async () => {
  await assert.rejects(main(['--expect-sha', 'main'], {}), /expect_sha_invalid/);
});
