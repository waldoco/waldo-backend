import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { nightlyDiagnostic } from '../src/channels/nightly-diagnostic';
import { ensureSchema } from '../src/tracer/schema';

describe('nightly diagnostic', () => {
  it('requires a live owner console session before exposing diagnostic state', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('nightly-diagnostic-unauth'));
    const response = await stub.fetch('https://telegram-owner/console/diagnostics/nightly');
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('nightly-memory');
  });

  it('returns only fixed nightly schedule/run state and the alarm without payload or private text', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('nightly-diagnostic'));
    await runInDurableObject(stub, async (_instance, state) => {
      ensureSchema(state.storage);
      state.storage.sql.exec(`INSERT INTO schedule (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts, created_at, updated_at)
        VALUES ('nightly-memory', 'dreaming', 1, 1, NULL, '{"id":"nightly-memory"}', 'armed', 0, 1, 1)`);
      state.storage.sql.exec(`INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt, outcome, settled_at, duration_ms)
        VALUES ('nightly-memory:1:1', 'nightly-memory', 'dreaming', 1, 1, 'failed', 2, 1)`);
      state.storage.sql.exec(`INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt, outcome, settled_at, duration_ms)
        VALUES ('other:1:1', 'other', 'heartbeat', 1, 1, 'ok', 2, 1)`);
      const result = await nightlyDiagnostic(state.storage);
      expect(result.schedule).toMatchObject({ id: 'nightly-memory', kind: 'dreaming', status: 'armed' });
      expect(result.runs).toEqual([expect.objectContaining({ id: 'nightly-memory:1:1', outcome: 'failed' })]);
      expect(result.alarm_at).toBeNull();
      expect(JSON.stringify(result)).not.toMatch(/payload|episode|other:1:1/);
    });
  });
});
