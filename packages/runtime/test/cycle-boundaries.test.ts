import { describe, expect, it } from 'vitest';
import { offAppPayload, offAppRoute } from '../src/health/cycle/off-app';
import { toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import { healthScoresView } from '../src/channels/app-health';
import ownerDo from '../src/channels/owner-do.ts?raw';
import expoPush from '../src/channels/expo-push.ts?raw';
import agentMailSend from '../src/channels/agent-mail/send.ts?raw';

// Where cycle context may and may not go (ADR-0085 D1, D6, D9; the owner's answer 3). Synthetic values only.
const BASIS = { kind: 'cycle_phase', explanation: 'Read against your own usual for this part of your cycle.' } as const;
const SEND_NOW: unique symbol = Symbol('send.now_only');

describe('the off-app strip (D6)', () => {
  it('removes every cycle-derived field wherever it sits, and keeps the rest, symbol keys included', () => {
    const payload = {
      chat_id: 42, text: 'Recovery looks good today.', [SEND_NOW]: true,
      scores: { recovery: { score: 74 }, basis: BASIS, reading_basis: BASIS },
      parts: [{ kind: 'text', text: 'hi' }, BASIS, { nested: { cycle_phase: 'luteal', last_period_start: '2026-03-01', last_source_name: 'Example Cycle', cycle_context: true, keep: 1 } }],
    };
    const clean = offAppPayload(payload)!;
    expect(clean).toEqual({ chat_id: 42, text: 'Recovery looks good today.', [SEND_NOW]: true, scores: { recovery: { score: 74 } }, parts: [{ kind: 'text', text: 'hi' }, { nested: { keep: 1 } }] });
    expect(clean[SEND_NOW]).toBe(true);
    expect(JSON.stringify(clean)).not.toMatch(/cycle|luteal|2026-03-01|Example Cycle|Read against/);
    expect(offAppPayload({ chat_id: 42, text: 'plain' })).toEqual({ chat_id: 42, text: 'plain' });
  });

  it('gives nothing for a payload it cannot walk, so the send drops', () => {
    const loop: Record<string, unknown> = { text: 'x' };
    loop.self = loop;
    expect(offAppPayload(loop)).toBeNull();
    let deep: Record<string, unknown> = { text: 'x' };
    for (let i = 0; i < 40; i += 1) deep = { inner: deep };
    expect(offAppPayload(deep)).toBeNull();
    expect(offAppPayload({ get text(): string { throw new Error('unreadable'); } })).toBeNull();
  });

  it('on an outbox route, sends only the stripped payload, and never allows a record it cannot strip', async () => {
    const sent: unknown[] = [];
    type Rec = { id: string; payload: Record<string, unknown> };
    const route = offAppRoute<Rec, Record<string, unknown>, { allowed(r: Rec): Promise<boolean>; send(p: Record<string, unknown>, r: Rec): Promise<unknown> }>(
      { allowed: async () => true, send: async payload => { sent.push(payload); return { ok: true }; } });
    const record: Rec = { id: 'r1', payload: { chat_id: 1, text: 'hello', basis: BASIS } };
    expect(await route.allowed(record)).toBe(true);
    await route.send(record.payload, record);
    expect(sent).toEqual([{ chat_id: 1, text: 'hello' }]);
    const loop: Record<string, unknown> = { chat_id: 1 };
    loop.self = loop;
    expect(await route.allowed({ id: 'r2', payload: loop })).toBe(false);
    await expect(route.send(loop, { id: 'r2', payload: loop })).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });

  it('wraps every surface but the app, and push and mail, in code', () => {
    expect(ownerDo).toContain('return OWNER_APP_SURFACE[surface] ? onSurface : offAppRoute(onSurface);');
    expect(ownerDo).toContain('{ app: true, telegram: false, whatsapp: false, imessage: false }');
    expect(expoPush).toContain('offAppPayload(devices.map(');
    expect(agentMailSend).toContain('const clean = offAppPayload(parts);');
  });
});

// Every runtime source file, read as text, keyed by its path under src/.
const RUNTIME = Object.entries((import.meta as unknown as { glob(pattern: string, options: object): Record<string, string> })
  .glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true })).map(([path, text]) => ({ path: path.replace('../src/', '/src/'), text }));

describe('only the owner turns it on (D1)', () => {
  it('the consent calls are reached from the app route alone: no tool, trigger or other caller', () => {
    const callers = RUNTIME.filter(file => /invokeCycle\([^)]*'consent_(grant|withdraw)'|cycle_consent_grant|cycle\.consent_grant/.test(file.text) || /operation: 'consent_grant'/.test(file.text) && file.text.includes('cycleConsentGrantV1Schema'));
    expect(callers.map(file => file.path.split('/src/')[1])).toEqual(['channels/app-cycle.ts']);
    const tools = RUNTIME.filter(file => file.path.includes('/src/tools/'));
    expect(tools.length).toBeGreaterThan(0);
    for (const file of tools) expect(file.text).not.toMatch(/invokeCycle|app-cycle|cycle_consent|reproductive_health|health\/cycle/);
  });
});

describe('the model never receives a cycle field (D6, D9, answer 3)', () => {
  it('the health context the model reads leaves out a stored basis, so no captured model text can carry one', () => {
    const clock = { timezone: 'UTC', now: () => new Date('2026-03-20T10:00:00Z') };
    const row = {
      context: {
        id: 'ctx-1', day: '2026-03-20', form: { score: 72, zone: 'good', confidence: 0.8 }, recovery: { score: 74, zone: 'good' }, weight: { score: 45, zone: 'moderate' },
        drivers: [], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: '2026-03-20T04:30:00.000Z', reading_basis: BASIS,
      },
      previous: null,
    } as unknown as HealthContextRow;
    const material = toContextHealthMaterial(row, clock);
    expect(material).not.toBeNull();
    expect(JSON.stringify(material)).not.toMatch(/cycle|reading_basis|Read against|phase/i);
  });

  it('no prompt, trace or capture code names the basis or a phase', () => {
    const capture = RUNTIME.filter(file => /\/src\/(llm|conversation|tracer|observability|langfuse)/.test(file.path) || /langfuse|prompt/i.test(file.path.split('/').pop() ?? ''));
    expect(capture.length).toBeGreaterThan(20);
    for (const file of capture) expect([file.path, /reading_basis|cycle_phase|cyclePhaseOn|health\/cycle/.test(file.text)]).toEqual([file.path, false]);
  });
});

describe('the scores the app reads (health revision 20)', () => {
  const stored = {
    scores: {
      day: '2026-03-20', timezone: 'UTC', compiled_at: '2026-03-20T08:00:00.000Z', freshness: 'fresh',
      recovery: { score: 74, zone: 'good', algorithm_version: 'recovery.v5', activation: 'accepted', confidence: 0.8, hrv_method: 'rmssd' },
      form: { reason: 'intraday_inputs_unavailable' }, weight: { reason: 'calendar_demand_unavailable' }, drivers: [], reading_basis: BASIS,
    },
  };
  const at = Date.parse('2026-03-20T09:00:00Z');
  const body = (revision: number, cycleBasis?: boolean) => (healthScoresView(stored, null, at, revision, cycleBasis === undefined ? {} : { cycleBasis }) as { body: Record<string, unknown> }).body;

  it('carry the basis only for a build that names revision 20, while HEALTH_CYCLE is "1"', () => {
    expect(body(20, true).basis).toEqual(BASIS);
    expect(body(19, true)).not.toHaveProperty('basis');
    expect(body(20, false)).not.toHaveProperty('basis');
    expect(body(20)).not.toHaveProperty('basis');
    for (const shown of [body(19, true), body(20, false), body(4)]) expect(JSON.stringify(shown)).not.toMatch(/cycle|reading_basis/);
  });

  it('keep every other field the same whether or not the basis is shown', () => {
    const { basis: _basis, ...rest } = body(20, true);
    expect(rest).toEqual(body(20, false));
  });

  it('leave out a stored basis that does not read', () => {
    const bad = { scores: { ...stored.scores, reading_basis: { ...BASIS, phase: 'luteal' } } };
    expect((healthScoresView(bad, null, at, 20, { cycleBasis: true }) as { body: Record<string, unknown> }).body).not.toHaveProperty('basis');
  });
});
