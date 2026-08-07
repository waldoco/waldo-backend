import { existsSync, readdirSync } from 'node:fs';

const expectedMigrations = [
  '20260709171312_0001_identity.sql',
  '20260709171336_0002_health.sql',
  '20260709171359_0003_intelligence.sql',
  '20260709171417_0004_comms.sql',
  '20260709171953_0005_integrations.sql',
  '20260709172043_0006_harden_rls_auto_enable_execute.sql',
  '20260710182949_reconcile_contract_spine.sql',
  '20260806180000_add_responsibility_session_authority.sql',
];

const migrationDir = new URL('../supabase/migrations/', import.meta.url);
if (!existsSync(migrationDir)) {
  throw new Error('supabase/migrations is missing');
}

const migrations = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
if (JSON.stringify(migrations) !== JSON.stringify(expectedMigrations)) {
  throw new Error(
    `migration list drifted\nexpected: ${expectedMigrations.join(', ')}\nactual: ${migrations.join(', ')}`,
  );
}

console.log(`canonical Supabase migration list verified (${migrations.length} migrations)`);
