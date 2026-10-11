import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const destination = fileURLToPath(new URL('./.staging/owner-roster.ts', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || !['--owner-scope', '--clear'].includes(args[0]))) {
  throw new Error('Use --owner-scope with the reviewed canonical scope, or --clear denied');
}
if (args[0] === '--clear' && args[1] !== 'denied') throw new Error('Invalid clear request');
const scope = args[0] === '--owner-scope' ? args[1] : undefined;
if (scope !== undefined && (!scope || scope.length > 512 || /[\u0000-\u001f]/.test(scope))) {
  throw new Error('Invalid canonical owner scope');
}
// A build creates the deny-all default only if no explicitly reviewed local roster exists.
if (!args.length && existsSync(destination)) process.exit(0);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `export const stagingOwnerScopes: readonly string[] = ${JSON.stringify(scope ? [scope] : [])};\n`, { mode: 0o600 });
console.log(scope ? 'Generated one-owner staging roster; identity not printed.' : 'Generated deny-all staging roster.');
