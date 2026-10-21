import { describe, expect, it } from 'vitest';
import candidate from '../../../docs/channels/imessage/migration-proposal/presence-provider.sql?raw';
import baseline from '../../../supabase/migrations/20260925110000_waldo_whatsapp_presence.sql?raw';

// Offline planned-statement proof only. No database client is constructed.
describe('iMessage candidate constraint dry-run', () => {
  it('preserves every existing presence provider and leaves link/redemption unchanged', () => {
    const providers = (sql: string) => [...sql.matchAll(/provider in \(([^)]+)\)/g)][0]![1]!.split(',').map(v => v.trim().replaceAll("'", ''));
    const prior = providers(baseline);
    expect(providers(candidate)).toEqual([...prior, 'imessage']);
    expect(candidate).not.toContain('link_codes');
    expect(candidate).not.toContain('create function');
    expect(candidate).not.toContain('grant ');
  });
  it('keeps candidate inactive, rolled back and outside migration discovery', () => {
    expect(candidate).toContain("check (provider <> 'imessage' or state <> 'active')");
    expect(candidate.trim().endsWith('rollback;')).toBe(true);
    expect(candidate).not.toContain('commit;');
    expect(candidate.match(/alter table/g)).toHaveLength(3);
    expect(candidate).not.toContain('delete ');
    expect(candidate).not.toContain('insert ');
  });
});
