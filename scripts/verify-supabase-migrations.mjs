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
  '20260924120000_waldo_owners.sql',
  '20260924130000_waldo_console_auth.sql',
  '20260924140000_waldo_settings_sync.sql',
  '20260924150000_waldo_admin.sql',
  '20260924160000_waldo_unlink.sql',
  '20260924170000_waldo_connections.sql',
  '20260924180000_waldo_connector_proxy.sql',
  '20260924190000_waldo_delete_owner.sql',
  '20260925000000_waldo_connect_sessions.sql',
  '20260925010000_waldo_console_sessions.sql',
  '20260925102000_waldo_invite_attribution.sql',
  '20260925110000_waldo_whatsapp_presence.sql',
  '20260925120000_waldo_console_sessions_revoke_public.sql',
  '20260925130000_waldo_open_signup.sql',
  '20260925170000_waldo_assert_channel_presence.sql',
  '20260926100000_waldo_proxy_access.sql',
  '20260926110000_waldo_proxy_idempotency.sql',
  '20260926120000_waldo_connect_session_ttl.sql',
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
