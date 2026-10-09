import test from 'node:test';
import assert from 'node:assert/strict';
import { stagingProviderAcceptance, STAGING_CSV, STAGING_REPORT, stagingWorkspaceComputeRequest } from './staging-acceptance.ts';
import { requireStagingComputeOwner } from './staging-owner-guard.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SourceTextModule, SyntheticModule } from 'node:vm';

const report = '# Order report\n\nLine items: 3\n\nTotal: $229.50\n\n- Notebook: 3 units\n- Desk, oak: 1 units\n- Pen: 10 units\n';
const result = () => ({ bytes: new TextEncoder().encode(report), exitCode: 0, stderr: '', stdout: JSON.stringify({
  platform: 'linux', network: 'denied', environment: 'PATH-only', line_items: 3, total: 229.5,
  execution_nonce: '11111111-1111-4111-8111-111111111111',
}) });
function fixture() {
  let stored = null; const calls = [];
  return { calls, service: {
    async recover(owner, id) { calls.push(['recover', owner, id]); return stored; },
    async execute(owner, request) { calls.push(['execute', owner, request]); stored ??= result(); return stored; },
    async cancel(owner, id) { calls.push(['cancel', owner, id]); },
  } };
}

test('private acceptance validates the report and reopens the same execution nonce', async () => {
  const f = fixture(); const accepted = await stagingProviderAcceptance(f.service, 'canonical-owner-scope', 'run1');
  assert.equal(accepted.receipt.replayedWithoutNewExecution, true);
  assert.equal(new TextDecoder().decode(accepted.artifact.bytes), report);
  assert.deepEqual(f.calls.map(call => call[0]), ['recover', 'execute', 'recover', 'execute', 'cancel']);
  assert.ok(f.calls.every(call => call[1] === 'canonical-owner-scope'));
  assert.equal(f.calls[1][2].timeoutMs, 30000);
  assert.equal(f.calls[1][2].inputs.length, 1);
});
test('a provider evidence failure cancels without claiming acceptance', async () => {
  const f = fixture(); f.service.execute = async () => ({ ...result(), stdout: '{}' });
  await assert.rejects(stagingProviderAcceptance(f.service, 'owner', 'run2'), /evidence invalid/);
  assert.equal(f.calls.at(-1)[0], 'cancel');
});
test('a newly executed replay nonce fails the replay proof', async () => {
  const f = fixture(); let issued = 0;
  f.service.execute = async () => {
    const r = result(); if (++issued === 2) r.stdout = r.stdout.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    return r;
  };
  f.service.recover = async () => issued ? result() : null;
  await assert.rejects(stagingProviderAcceptance(f.service, 'owner', 'run3'), /replay mismatch/);
  assert.equal(f.calls.at(-1)[0], 'cancel');
});
test('reuse and invalid run identities issue no executable operation', async () => {
  const f = fixture(); f.service.recover = async () => result();
  await assert.rejects(stagingProviderAcceptance(f.service, 'owner', 'reused'), /already used/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(stagingProviderAcceptance(f.service, 'owner', '../bad'), /identity/);
  assert.equal(f.calls.length, 0);
});
test('unconfigured, other-owner and broad rosters deny before a service operation', () => {
  for (const [scopes, owner] of [[[], 'owner'], [['owner'], 'other'], [['owner', 'other'], 'owner']]) {
    assert.throws(() => requireStagingComputeOwner(scopes, owner), /not admitted/);
  }
  requireStagingComputeOwner(['canonical-physical-owner-scope'], 'canonical-physical-owner-scope');
});

test('actual staging RPC wrapper denies every method before allocating another owner instance', async () => {
  const require = createRequire(import.meta.url);
  const ts = require('../../packages/runtime/node_modules/typescript');
  const source = readFileSync(new URL('./staging-worker.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const make = async scopes => {
    const module = new SourceTextModule(code);
    const exports = {
      'cloudflare:workers': { WorkerEntrypoint: class { constructor(_ctx, env) { this.env = env; } } },
      './worker': { OwnerComputeContainer: class {} },
      './staging-owner-guard': { requireStagingComputeOwner },
      './.staging/owner-roster': { stagingOwnerScopes: scopes },
    };
    await module.link(specifier => {
      const values = exports[specifier];
      return new SyntheticModule(Object.keys(values), function() { for (const [key, value] of Object.entries(values)) this.setExport(key, value); });
    });
    await module.evaluate();
    const calls = [];
    const instance = new module.namespace.default({}, { OWNER_COMPUTE: {
      idFromName(name) { calls.push(['allocate', name]); return name; },
      get(id) { return {
        execute(owner, request) { calls.push(['execute', owner, request.operationId, id]); },
        recover(owner, op) { calls.push(['recover', owner, op, id]); },
        cancel(owner, op) { calls.push(['cancel', owner, op, id]); },
      }; },
    } });
    return { instance, calls };
  };
  for (const scopes of [[], ['canonical-owner']]) {
    const f = await make(scopes);
    for (const method of ['execute', 'recover', 'cancel']) {
      assert.throws(() => f.instance[method]('other-owner', method === 'execute' ? {operationId:'op'} : 'op'), /not admitted/);
    }
    assert.deepEqual(f.calls, []);
    assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(f.instance)), ['constructor', 'execute', 'recover', 'cancel', 'fetch']);
    assert.equal(f.instance.fetch().status, 404);
  }
  const admitted = await make(['canonical-owner']);
  admitted.instance.execute('canonical-owner', { operationId: 'op' });
  assert.deepEqual(admitted.calls[0], ['allocate', '["canonical-owner","op"]']);
});

test('fixed owner tool request uses an exact saved file revision and bounded report destination', () => {
  const request = stagingWorkspaceComputeRequest('file-123', 2);
  assert.deepEqual(request.inputs, [{file_id:'file-123',revision:2,path:'orders.csv'}]);
  assert.equal(request.argv[0], 'node');
  assert.equal(request.timeout_ms, 30000);
  assert.equal(request.max_output_bytes, 16384);
  assert.equal(request.output_path, 'report.md');
  assert.equal(request.expected_revision, 0);
  assert.equal(STAGING_REPORT, report);
  assert.ok(STAGING_CSV.includes('"Desk, oak"'));
});
