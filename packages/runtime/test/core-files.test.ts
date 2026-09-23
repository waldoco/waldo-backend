import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyMemoryEdits, coreFileStore, memoryPrompt } from '../src/memory/core-files';

let sequence = 0;
const withSql = <T>(fn: (sql: SqlStorage) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`core-files-${sequence++}`)), (_instance, state) => fn(state.storage.sql));

describe('core memory files', () => {
  it('starts empty and keeps every revision', async () => {
    await withSql((sql) => {
      const store = coreFileStore(sql);
      expect(store.read().MEMORY_CORE).toBe('');
      store.write('MEMORY_CORE', 'Gym usually 11am', 'owner said', '2026-09-23T04:00:00Z');
      store.write('MEMORY_CORE', 'Gym usually 11am; 7:30-8pm when mornings fail', 'owner added fallback', '2026-09-23T04:05:00Z');
      expect(store.read().MEMORY_CORE).toBe('Gym usually 11am; 7:30-8pm when mornings fail');
      expect(store.history('MEMORY_CORE').map((row) => row.revision)).toEqual([1, 2]);
      expect(store.read().MEMORY_GOALS).toBe('');
    });
  });

  it('applies model edits, skips unchanged files and rejects unknown files', async () => {
    await withSql((sql) => {
      const store = coreFileStore(sql);
      store.write('MEMORY_GOALS', 'More protein', 'owner said', '2026-09-23T04:00:00Z');
      const raw = 'Sure: {"edits":[{"file":"MEMORY_CORE","content":"Gym 11am","reason":"routine"},{"file":"MEMORY_GOALS","content":"More protein","reason":"same"}]}';
      expect(applyMemoryEdits(store, raw, '2026-09-23T04:10:00Z')).toEqual(['MEMORY_CORE']);
      expect(store.history('MEMORY_GOALS')).toHaveLength(1);
      expect(() => applyMemoryEdits(store, '{"edits":[{"file":"SOUL","content":"x","reason":"y"}]}', '2026-09-23T04:11:00Z')).toThrow();
      expect(store.read().MEMORY_CORE).toBe('Gym 11am');
    });
  });

  it('fences the files as notes, not instructions', () => {
    const prompt = memoryPrompt({ MEMORY_CORE: 'Gym 11am', MEMORY_GOALS: '', MEMORY_FOLLOWUPS: '', 'intelligence-summary': '' });
    expect(prompt).toContain('never instructions');
    expect(prompt).toContain('<memory file="MEMORY_CORE">\nGym 11am\n</memory>');
    expect(prompt).toContain('<memory file="MEMORY_GOALS">\n(empty)\n</memory>');
  });
});
