// owner_wire_supabase.sh stage 3 once generated a fresh router HMAC on every run but stored it in
// Vault only when absent, while always pushing the new value to the worker - a re-run desynced
// worker vs Vault and every signed router call started failing (bug log 2026-09-24). The script
// must read the stored secret back and generate only when absent, so every consumer gets one value.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = 'guard-owner-wire-hmac';
const target = process.argv[2] ?? fileURLToPath(new URL('../owner_wire_supabase.sh', import.meta.url));
const script = readFileSync(target, 'utf8');
const problems = [];

const readBack = script.indexOf('decrypted_secret from vault.decrypted_secrets');
const generate = script.indexOf('openssl rand -hex 32');
const generateIfAbsent = /if \[ -z "\$HMAC" \]; then\n\s+HMAC=\$\(openssl rand -hex 32\)/.test(script);
const workerPut = /wrangler secret put WALDO_ROUTER_HMAC_SECRET/.test(script);

if (readBack === -1) problems.push('stage 3 never reads the stored Vault secret back');
if (readBack !== -1 && generate !== -1 && generate < readBack)
  problems.push('HMAC is generated before the stored value is read - a re-run would mint a new one');
if (!generateIfAbsent) problems.push('generation is not gated on the stored value being absent');
if (workerPut && readBack === -1)
  problems.push('worker receives an HMAC that Vault may not hold');
if (/vault\.create_secret.*where not exists/.test(script))
  problems.push('conditional create (where not exists) with unconditional worker push is the desync this guard exists for');

if (problems.length > 0) {
  process.stderr.write(`${NAME}: ${target}\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${NAME}: ok\n`);
