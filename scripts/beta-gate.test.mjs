import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BETA_CONFIG, BETA_SUPABASE_PROJECT, betaProbes, main } from './beta-gate.mjs';
import { STAGING_WORKER_URL } from './staging-gate.mjs';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const SHA = 'abc1234';

// A healthy beta Worker as the probes see it: every refusal path answers as the config says it should.
const healthy = (vars) => async (url, init) => {
  const { pathname } = new URL(url);
  const answer = {
    '/healthz': [200, { ok: true, release: SHA }],
    '/app/v1/controls': [401, { error: 'unavailable' }],
    '/console': [303, null],
    '/probe/turn': [404, null],
    '/telegram/webhook': [404, null],
    '/whatsapp/webhook': init.method === 'GET' ? [403, null] : [vars.WHATSAPP_WALDO_NUMBER ? 403 : 404, null],
    '/events/gmail': [vars.GMAIL_PUSH_PROJECT ? 403 : 404, null],
    '/functions/v1/connector-proxy': [401, null],
  }[pathname];
  return new Response(answer[1] === null ? null : JSON.stringify(answer[1]), { status: answer[0] });
};

const quiet = async (fn) => {
  const log = console.log; const lines = [];
  console.log = (line) => lines.push(line);
  try { return { code: await fn(), lines }; } finally { console.log = log; }
};

test('beta probes its own origin, never staging, and the committed beta block is the one read', () => {
  assert.equal(BETA_CONFIG.name, 'waldo-runtime-beta');
  assert.match(BETA_CONFIG.vars.WALDO_PUBLIC_ORIGIN, /^https:\/\/[a-z.]+$/);
  assert.notEqual(BETA_CONFIG.vars.WALDO_PUBLIC_ORIGIN, STAGING_WORKER_URL);
  assert.equal(BETA_SUPABASE_PROJECT, '', 'the project ref is committed only after the owner creates the project');
});

test('a channel beta has not set up is expected to answer 404, and 403 once its config names it', () => {
  const expectation = (vars, name) => betaProbes(vars, '').find(([probe]) => probe === name)[3];
  assert.equal(expectation({}, 'gmail-push-unsigned')({ status: 404 }).pass, true);
  assert.equal(expectation({}, 'gmail-push-unsigned')({ status: 403 }).pass, false);
  assert.equal(expectation({ GMAIL_PUSH_PROJECT: 'beta-project' }, 'gmail-push-unsigned')({ status: 403 }).pass, true);
  assert.equal(expectation({}, 'whatsapp-unsigned')({ status: 404 }).pass, true);
  assert.equal(expectation({ WHATSAPP_WALDO_NUMBER: '15550000000' }, 'whatsapp-unsigned')({ status: 403 }).pass, true);
  assert.equal(expectation({}, 'probe-route-closed')({ status: 200 }).pass, false, 'the staging probe route must never answer on beta');
});

test('the edge-function probe runs only once a project ref is committed', () => {
  assert.equal(betaProbes({}, '').some(([name]) => name === 'connector-proxy-unsigned'), false);
  assert.equal(betaProbes({}, 'abcdefghijklmnopqrst').some(([name]) => name === 'connector-proxy-unsigned'), true);
});

test('a healthy Worker without credentials is INCOMPLETE, never PASS', async () => {
  const { code, lines } = await quiet(() => main(['--expect-sha', SHA], {}, { fetcher: healthy(BETA_CONFIG.vars), wait: async () => {} }));
  assert.equal(code, 2);
  assert.ok(lines.includes('GATE INCOMPLETE'));
  assert.ok(!lines.some((line) => line.startsWith('FAIL ')), lines.join('\n'));
});

test('a stale release, an open probe route or a bound browser fails the gate', async () => {
  const stale = await quiet(() => main(['--expect-sha', 'def5678'], {}, { fetcher: healthy(BETA_CONFIG.vars), wait: async () => {} }));
  assert.equal(stale.code, 1);
  const open = async (url, init) => (new URL(url).pathname === '/probe/turn' ? new Response(null, { status: 200 }) : healthy(BETA_CONFIG.vars)(url, init));
  assert.equal((await quiet(() => main([], {}, { fetcher: open }))).code, 1);
  const cli = ([command, , id]) => (command === 'deployments'
    ? [{ created_on: '2026-11-04T00:00:00Z', versions: [{ version_id: V2, percentage: 100 }] }, { created_on: '2026-11-03T00:00:00Z', versions: [{ version_id: V1, percentage: 100 }] }]
    : { id, resources: { bindings: [{ type: 'plain_text', name: 'WALDO_RELEASE', text: SHA }, { type: 'browser', name: 'BROWSER' }] } });
  const browser = await quiet(() => main([], { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' }, { fetcher: healthy(BETA_CONFIG.vars), cli, project: 'abcdefghijklmnopqrst' }));
  assert.equal(browser.code, 1);
  assert.ok(browser.lines.some((line) => line.startsWith('FAIL no-browser-binding')));
  assert.ok(browser.lines.some((line) => line.includes(`scripts/beta-rollback.sh ${V1} --confirm ${V1}`)));
});

test('with credentials and a project ref, a healthy beta passes', async () => {
  const cli = ([command, , id]) => (command === 'deployments'
    ? [{ created_on: '2026-11-04T00:00:00Z', versions: [{ version_id: V2, percentage: 100 }] }]
    : { id, resources: { bindings: [{ type: 'plain_text', name: 'WALDO_RELEASE', text: SHA }] } });
  const { code } = await quiet(() => main(['--expect-sha', SHA], { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' }, { fetcher: healthy(BETA_CONFIG.vars), cli, project: 'abcdefghijklmnopqrst', wait: async () => {} }));
  assert.equal(code, 0);
});

test('refuses a malformed sha and a block with no origin', async () => {
  await assert.rejects(() => main(['--expect-sha', 'zz'], {}), /expect_sha_invalid/);
  await assert.rejects(() => main([], {}, { config: { vars: {} } }), /beta_origin_unset/);
});
