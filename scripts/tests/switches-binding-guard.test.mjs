import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BINDING_BUDGET, checkConfig, checkSources, runbookSecretNames } from '../guards/guard-switches-binding.mjs';
import { parseJsonc } from '../jsonc.mjs';
import { flatConfig } from '../wrangler-vars.mjs';

const root = new URL('../../', import.meta.url);
const config = parseJsonc(readFileSync(new URL('packages/runtime/wrangler.jsonc', root), 'utf8'));
const secrets = runbookSecretNames(readFileSync(new URL('docs/ops/PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md', root), 'utf8'));
const clone = () => structuredClone(config);

test('the runbook names the deployed secrets, an upper bound on what Cloudflare counts', () => {
  assert.ok(secrets.length >= 32, `${secrets.length} names`);
  assert.ok(secrets.includes('OPENAI_API_KEY') && secrets.includes('WEATHERKIT_PRIVATE_KEY') && secrets.includes('TWILIO_AUTH_TOKEN'));
  assert.deepEqual(runbookSecretNames('### 1.3 Worker secrets\n\nno table\n### 1.4'), []);
});

test('the config as it stands passes, and every switch is flat-equal to what the Worker reads', () => {
  assert.deepEqual(checkConfig(config, secrets).bad, []);
});

test('the 1808c6ed shape, every switch its own var, fails on the binding count and on the flat vars', () => {
  const { bad } = checkConfig(flatConfig(config), secrets);
  assert.ok(bad.some((line) => line.includes(`over ${BINDING_BUDGET}`)), bad.join('\n'));
  assert.ok(bad.some((line) => line.includes('var "DEVICE_WEATHER" must go in WALDO_SWITCHES')), bad.join('\n'));
});

test('a new flat var, a non-string switch, a name in both places, an oversized object or no runbook names each fail', () => {
  const cases = [
    [(c) => { c.env.staging.vars.NEW_SWITCH = '1'; }, 'var "NEW_SWITCH" must go in WALDO_SWITCHES'],
    [(c) => { c.vars.WALDO_SWITCHES.DEVICE_PLACE = 1; }, 'WALDO_SWITCHES.DEVICE_PLACE must be a string'],
    [(c) => { c.vars.WALDO_SWITCHES.WALDO_ENVIRONMENT = 'staging'; }, '"WALDO_ENVIRONMENT" is declared both flat and in WALDO_SWITCHES'],
    [(c) => { c.env.staging.vars.WALDO_SWITCHES.FILLER = 'x'.repeat(5000); }, 'bytes, over'],
    [(c) => { delete c.env.staging.vars.WALDO_SWITCHES; }, 'staging: WALDO_SWITCHES must be an object'],
  ];
  for (const [mutate, expected] of cases) {
    const c = clone();
    mutate(c);
    const { bad } = checkConfig(c, secrets);
    assert.ok(bad.some((line) => line.includes(expected)), `${expected}:\n${bad.join('\n')}`);
  }
  assert.ok(checkConfig(config, []).bad.some((line) => line.includes('no secret names')));
});

const doClass = (superArgs) => `import { DurableObject } from 'cloudflare:workers';
export class SomeDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) { super(${superArgs}); }
}`;

test('a Durable Object or entrypoint that does not flatten its env, or any other way around the seam, fails', () => {
  assert.deepEqual(checkSources([{ path: 'src/some-do.ts', text: doClass('ctx, withSwitches(env)') }]), []);
  assert.match(checkSources([{ path: 'src/some-do.ts', text: doClass('ctx, env') }]).join(), /class SomeDO must call super\(ctx, withSwitches\(env\)\)/);
  assert.match(checkSources([{ path: 'src/some-do.ts', text: 'export class Quiet extends DurableObject<Env> {}' }]).join(), /class Quiet must call/);
  assert.match(checkSources([{ path: 'src/w.ts', text: 'export class W extends WorkerEntrypoint<Env> { constructor(c, e) { super(c, e); } }' }]).join(), /class W must call/);
  assert.deepEqual(checkSources([{ path: 'src/retired-durable-objects.ts', text: 'export class TracerDO extends DurableObject<Env> {}' }]), []);
  assert.match(checkSources([{ path: 'src/a.ts', text: "import { env as bindings } from 'cloudflare:workers';" }]).join(), /imports env from cloudflare:workers/);
  assert.match(checkSources([{ path: 'src/a.ts', text: 'const on = process.env.DEVICE_PLACE;' }]).join(), /reads process.env/);
  assert.deepEqual(checkSources([{ path: 'src/cli/local-chat.ts', text: 'const key = process.env.OPENAI_API_KEY;' }]), []);
});

test('every handler of the Worker\'s default export flattens its env', () => {
  const ok = 'export default { fetch: (r, env, c) => worker.fetch(r, withSwitches(env), c), email: (m, env) => worker.email(m, withSwitches(env)) } satisfies ExportedHandler<Env>;';
  assert.deepEqual(checkSources([{ path: 'src/index.ts', text: ok }]), []);
  assert.match(checkSources([{ path: 'src/index.ts', text: 'export default { ...worker, fetch: (r, env) => worker.fetch(r, withSwitches(env)) };' }]).join(), /default export entry "\.\.\.worker"/);
  assert.match(checkSources([{ path: 'src/index.ts', text: 'export default { scheduled: (c, env, x) => worker.scheduled(c, env, x) };' }]).join(), /handler scheduled must take env and pass withSwitches/);
  assert.match(checkSources([{ path: 'src/index.ts', text: 'export default { fetch: (r, env, c) => { oauthStateSecret(env); return worker.fetch(r, withSwitches(env), c); } };' }]).join(), /handler fetch uses env other than as withSwitches\(env\)/);
  assert.match(checkSources([{ path: 'src/index.ts', text: 'export default { fetch: (r, env, c) => env.DEVICE_PLACE === "1" ? worker.fetch(r, withSwitches(env), c) : none };' }]).join(), /handler fetch uses env other than/);
});

// Moving the switches into WALDO_SWITCHES changed no var the Worker reads: every name 1808c6ed (the last config before the
// move) declared is still declared in the same environment with the same value. A later deliberate change to one of those
// values moves this pin to the commit that made it.
const BEFORE_MOVE = '1808c6ed83c9d84be2b4ae36ad05e9d27343b772';
test('the move kept every var the Worker reads, by name and value, in both environments', (t) => {
  const old = spawnSync('git', ['show', `${BEFORE_MOVE}:packages/runtime/wrangler.jsonc`], { cwd: root, encoding: 'utf8' });
  if (old.status !== 0) { t.skip(`${BEFORE_MOVE} is not in this clone's history`); return; }
  const before = parseJsonc(old.stdout), now = flatConfig(config);
  assert.equal(Object.keys(before.vars).length, 109);
  for (const [label, was, is] of [['production', before.vars, now.vars], ['staging', before.env.staging.vars, now.env.staging.vars], ['previews', before.previews.vars, now.previews.vars]]) {
    for (const [name, value] of Object.entries(was)) assert.deepEqual([label, name, is[name]], [label, name, value]);
  }
});
