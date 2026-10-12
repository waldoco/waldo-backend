import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// A local compatibility probe, never a deployment or browser workload. Import the
// actual pinned SDK alongside the complete Worker so lazy-import tree shaking
// cannot hide unsupported native modules. Source Wrangler config stays unchanged.
test('activated staging entrypoint selects Cloudflare while the full Worker and pinned SDK start with documented compatibility', { timeout: 120000 }, async () => {
  const runtime = resolve('packages/runtime');
  const { Miniflare } = createRequire(resolve(realpathSync(resolve(runtime, 'node_modules/@cloudflare/vitest-pool-workers')), 'package.json'))('miniflare');
  const source = JSON.parse(readFileSync(resolve(runtime, 'wrangler.jsonc'), 'utf8').replace(/\/\/[^\n]*/g, ''));
  const staging = source.env.staging;
  const dir = mkdtempSync(resolve(tmpdir(), 'waldo-cf-public-bundle-'));
  const entry = resolve(dir, 'configured.ts'), out = resolve(dir, 'bundle');
  let worker;
  try {
    writeFileSync(entry, `import * as sdk from ${JSON.stringify(resolve(runtime, 'node_modules/@cloudflare/playwright/lib/index.js'))};\nimport worker from ${JSON.stringify(resolve(runtime, staging.main))};\nimport {browserPublicReadConfiguration} from ${JSON.stringify(resolve(runtime, 'src/channels/browser-public-read-configuration.ts'))};\nexport * from ${JSON.stringify(resolve(runtime, 'src/index.ts'))};\nexport default {fetch(request, env, ctx) {if(new URL(request.url).pathname === '/do-probe') return env.TELEGRAM_OWNER_DO.get(env.TELEGRAM_OWNER_DO.idFromName('cf-registered-two-arg-probe')).fetch(new Request('https://owner.invalid/console/browser/trial')); if(new URL(request.url).pathname === '/sdk-probe') return Response.json({acquire:typeof sdk.acquire,connect:typeof sdk.connect,sessions:typeof sdk.sessions,staging:browserPublicReadConfiguration({WALDO_ENVIRONMENT:'staging',BROWSER:{}}).defaultProvider,production:browserPublicReadConfiguration({WALDO_ENVIRONMENT:'production',BROWSER:{}}).defaultProvider}); return worker.fetch(request,env,ctx);}};`);
    const config = resolve(dir, 'wrangler.json');
    writeFileSync(config, JSON.stringify({ name: 'waldo-cf-local-compatibility', main: entry, compatibility_date: source.compatibility_date,
      compatibility_flags: staging.compatibility_flags, durable_objects: source.durable_objects, migrations: source.migrations }));
    execFileSync('pnpm', ['exec', 'wrangler', 'versions', 'upload', '--config', config, '--dry-run', '--outdir', out], { cwd: runtime, encoding: 'utf8', timeout: 60000 });
    worker = new Miniflare({ workers: [{ modules: true, modulesRoot: out, scriptPath: resolve(out, 'configured.js'),
      compatibilityDate: source.compatibility_date, compatibilityFlags: staging.compatibility_flags, bindings: { WALDO_RELEASE: 'cf-bundle-probe', WALDO_ENVIRONMENT: 'staging' },
      durableObjects: Object.fromEntries(staging.durable_objects.bindings.map(binding => [binding.name, { className: binding.class_name, useSQLite: true }])),
    }] });
    const sdk = await worker.dispatchFetch('https://worker.invalid/sdk-probe');
    assert.equal(sdk.status, 200);
    assert.deepEqual(await sdk.json(), { acquire: 'function', connect: 'function', sessions: 'function', staging: 'cloudflare_playwright', production: 'browserbase_stagehand_http_v3' });
    // An actual registered DO is constructed with only state and bindings; its
    // optional fixture trial remains absent and performs no provider I/O.
    const owner = await worker.dispatchFetch('https://worker.invalid/do-probe');
    assert.equal(owner.status, 401); // existing console authentication runs before optional trial routing
    const health = await worker.dispatchFetch('https://worker.invalid/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, release: 'cf-bundle-probe' });
  } finally { await worker?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
