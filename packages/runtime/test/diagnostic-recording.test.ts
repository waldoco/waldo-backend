import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIAGNOSTIC_READ_TIMEOUT_MS, DIAGNOSTIC_RECORDING_WORDING, diagnosticRecordingDirectory, readDiagnosticAgreement, type DiagnosticRecordingDirectory } from '../src/identity/diagnostic-recording';
import { routerSignature } from '../src/identity/owner-directory';
import { resolveOwnerCapture } from '../src/observability/trace-privacy';

const env = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const AT = Date.parse('2026-10-22T09:00:00Z');
type Call = Readonly<{ fn: string; body: Record<string, unknown> }>;
const recorder = (answer: unknown, status = 200) => {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ fn: String(input).split('/rpc/')[1]!, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json(answer, { status });
  }) as typeof fetch;
  return { calls, directory: diagnosticRecordingDirectory(env, fetcher, () => AT)! };
};
const current = { agreed: true, version: DIAGNOSTIC_RECORDING_WORDING.version, agreed_at: '2026-10-22T09:00:00.000Z' };

afterEach(() => { vi.useRealTimers(); });

describe('the directory calls', () => {
  it('signs the read for exactly this owner', async () => {
    const { calls, directory } = recorder(current);
    expect(await directory.read('owner-a')).toEqual({ agreed: true, version: DIAGNOSTIC_RECORDING_WORDING.version });
    expect(calls).toEqual([{ fn: 'diagnostic_recording_state', body: { p_do_name: 'owner-a', p_at: AT / 1000, p_sig: await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, AT / 1000, 'diagnostic.read.owner-a') } }]);
  });

  it('signs every argument of a change, with the current wording version', async () => {
    const { calls, directory } = recorder(true);
    expect(await directory.set('owner-a', true, 'signup')).toBe(true);
    expect(await directory.set('owner-a', false, 'console')).toBe(true);
    const version = DIAGNOSTIC_RECORDING_WORDING.version;
    expect(calls[0]).toEqual({ fn: 'set_diagnostic_recording', body: { p_do_name: 'owner-a', p_agreed: true, p_version: version, p_source: 'signup', p_at: AT / 1000,
      p_sig: await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, AT / 1000, `diagnostic.set.owner-a.on.${version}.signup`) } });
    expect(calls[1]!.body).toMatchObject({ p_agreed: false, p_sig: await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, AT / 1000, `diagnostic.set.owner-a.off.${version}.console`) });
  });

  it('reports a refused change as false and an unreachable directory as a throw', async () => {
    expect(await recorder(false).directory.set('owner-a', true, 'console')).toBe(false);
    await expect(recorder({ code: 'XX000' }, 503).directory.set('owner-a', true, 'console')).rejects.toThrow();
  });

  it('has no directory without its configuration', () => {
    expect(diagnosticRecordingDirectory({ ...env, WALDO_ROUTER_HMAC_SECRET: undefined })).toBeNull();
  });

  it('keeps the wording version inside what the database accepts', () => {
    expect(DIAGNOSTIC_RECORDING_WORDING.version).toMatch(/^[a-z0-9][a-z0-9.-]{0,39}$/);
  });
});

describe('reading the agreement for a turn answers yes only for a clear, current yes', () => {
  const answering = (read: DiagnosticRecordingDirectory['read']): DiagnosticRecordingDirectory => ({ read, set: async () => true });

  it('agreed to the current wording', async () => {
    expect(await readDiagnosticAgreement(recorder(current).directory, 'owner-a')).toBe(true);
  });

  it.each([
    ['never agreed', { agreed: false, version: null, agreed_at: null }],
    ['older wording', { ...current, version: 'beta-2026-01-01' }],
    ['no active owner', null],
    ['a malformed answer', { agreed: 'yes', version: DIAGNOSTIC_RECORDING_WORDING.version }],
    ['a bare true', true],
  ])('%s', async (_label, answer) => {
    expect(await readDiagnosticAgreement(recorder(answer).directory, 'owner-a')).toBe(false);
  });

  it('an unreachable directory', async () => {
    expect(await readDiagnosticAgreement(recorder({ code: 'XX000' }, 503).directory, 'owner-a')).toBe(false);
  });

  it('no directory, or no DO name to ask about', async () => {
    expect(await readDiagnosticAgreement(null, 'owner-a')).toBe(false);
    expect(await readDiagnosticAgreement(recorder(current).directory, undefined)).toBe(false);
  });

  it('a directory that does not answer in time', async () => {
    vi.useFakeTimers();
    const read = readDiagnosticAgreement(answering(() => new Promise(() => undefined)), 'owner-a');
    await vi.advanceTimersByTimeAsync(DIAGNOSTIC_READ_TIMEOUT_MS);
    expect(await read).toBe(false);
  });

  it('a late yes after the deadline', async () => {
    vi.useFakeTimers();
    const read = readDiagnosticAgreement(answering(() => new Promise(resolve => setTimeout(() => resolve({ agreed: true, version: DIAGNOSTIC_RECORDING_WORDING.version }), DIAGNOSTIC_READ_TIMEOUT_MS + 1))), 'owner-a');
    await vi.advanceTimersByTimeAsync(DIAGNOSTIC_READ_TIMEOUT_MS + 1);
    expect(await read).toBe(false);
  });
});

describe('an owner\'s capture needs both the environment and their agreement', () => {
  it.each([
    [{ LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'staging' }, true, true],
    [{ LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'staging' }, false, false],
    [{ LANGFUSE_CAPTURE_TEXT: 'false', WALDO_ENVIRONMENT: 'staging' }, true, false],
    [{ LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'production' }, true, false],
    [{ LANGFUSE_CAPTURE_TEXT: 'true' }, false, false],
  ])('%o, agreed %s → %s', (environment, agreed, expected) => {
    expect(resolveOwnerCapture(environment, agreed)).toBe(expected);
  });
});
