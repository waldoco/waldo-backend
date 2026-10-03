import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { provisionDoSchema } from '../src/do-schema';
import { toolNameSchema } from '@waldo/contracts';
import { EXTERNAL_READ_TOOLS, SOURCE_SCOPE_CLASS, SourceScopeStore } from '../src/tools/source-scope';

const withDo = (name: string, run: (sql: SqlStorage) => Promise<void>) =>
  runInDurableObject(env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(name)), async (_, state) => { provisionDoSchema(state.storage); await run(state.storage.sql); });
const owner = { trigger: 'user_message', toolArgSourceTaint: null } as const;
const NOW = 1_800_000_000_000;

it('default is no limit: every tool is allowed and no prompt line is added', async () => {
  await withDo('scope-default', async (sql) => {
    const s = new SourceScopeStore(sql);
    expect(s.current()).toBe('none');
    for (const tool of EXTERNAL_READ_TOOLS) expect(s.denies(tool)).toBe(false);
    expect(s.promptLine()).toBeNull();
  });
});

it('an owner-origin limit denies every external-read tool and nothing else, and survives a follow-up turn and a restart', async () => {
  await withDo('scope-holds', async (sql) => {
    const s = new SourceScopeStore(sql);
    expect(s.set('pasted_only', owner, NOW).ok).toBe(true);
    for (const tool of EXTERNAL_READ_TOOLS) expect(s.denies(tool)).toBe(true);
    for (const tool of ['set_reminder', 'cancel_reminder', 'set_proactivity', 'draft_email']) expect(s.denies(tool)).toBe(false);
    // a later turn (new instance over the same durable state, as after a restart)
    const later = new SourceScopeStore(sql);
    expect(later.current()).toBe('pasted_only');
    expect(later.denies('search_communication')).toBe(true);
  });
});

it('retrieved or untrusted content cannot clear or set it: only an untainted owner message can', async () => {
  await withDo('scope-untrusted', async (sql) => {
    const s = new SourceScopeStore(sql);
    s.set('pasted_only', owner, NOW);
    for (const ctx of [{ trigger: 'user_message', toolArgSourceTaint: 'external' }, { trigger: 'user_message', toolArgSourceTaint: 'mixed' }, { trigger: 'scheduled', toolArgSourceTaint: null }, { trigger: 'event', toolArgSourceTaint: null }] as const) {
      const result = s.set('none', ctx, NOW + 1);
      expect(result.ok).toBe(false);
      expect(s.current()).toBe('pasted_only');
    }
    expect(s.set('none', owner, NOW + 2).ok).toBe(true);
    expect(s.current()).toBe('none');
    expect(s.denies('search_communication')).toBe(false);
  });
});

it('an untrusted context cannot turn a limit on either', async () => {
  await withDo('scope-untrusted-set', async (sql) => {
    const s = new SourceScopeStore(sql);
    expect(s.set('pasted_only', { trigger: 'user_message', toolArgSourceTaint: 'external' }, NOW).ok).toBe(false);
    expect(s.current()).toBe('none');
  });
});

it('the active limit is surfaced to the model every turn so a new task can clear it; nothing expires or clears it silently', async () => {
  await withDo('scope-surface', async (sql) => {
    const s = new SourceScopeStore(sql);
    s.set('pasted_only', owner, NOW);
    const line = s.promptLine();
    expect(line).toContain('pasted');
    expect(line).toContain('set_source_scope');
    // no API but an owner-origin set('none') changes it: cancel/stop and time do not
    expect(new SourceScopeStore(sql).current()).toBe('pasted_only');
    s.set('none', owner, NOW + 5);
    expect(s.promptLine()).toBeNull();
  });
});

it('rejects an unknown scope value and a malformed stored row fails closed to the limit', async () => {
  await withDo('scope-closed', async (sql) => {
    const s = new SourceScopeStore(sql);
    expect(s.set('everything' as never, owner, NOW).ok).toBe(false);
    sql.exec(`INSERT OR REPLACE INTO owner_source_scope(id,scope,set_at) VALUES(1,'garbage',0)`);
    expect(new SourceScopeStore(sql).current()).toBe('pasted_only');
  });
});

it('every tool name is classified deny or allow, and denies() agrees with the class; a new tool fails here until classified', async () => {
  await withDo('scope-classified', async (sql) => {
    const s = new SourceScopeStore(sql);
    s.set('pasted_only', owner, NOW);
    for (const name of toolNameSchema.options) {
      expect(['deny', 'allow']).toContain(SOURCE_SCOPE_CLASS[name]);
      expect(s.denies(name)).toBe(SOURCE_SCOPE_CLASS[name] === 'deny');
    }
    expect(Object.keys(SOURCE_SCOPE_CLASS).sort()).toEqual([...toolNameSchema.options].sort());
    for (const name of ['search_communication', 'get_communication', 'read_thread', 'read_drive', 'query_calendar', 'query_availability', 'web_search', 'browse_page', 'browse_act', 'read_memory', 'read_owner_context', 'search_episodes', 'read_document', 'search_connector', 'read_tool_output', 'workspace_read', 'workspace_list', 'read_mcp_tool', 'call_mcp_tool'] as const) expect(s.denies(name)).toBe(true);
    for (const name of ['get_context', 'set_reminder', 'list_reminders', 'cancel_reminder', 'draft_email', 'set_proactivity'] as const) expect(s.denies(name)).toBe(false);
  });
});
