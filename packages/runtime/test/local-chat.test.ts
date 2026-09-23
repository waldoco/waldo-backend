import { describe, expect, it } from 'vitest';
import {
  LOCAL_CLI_MODEL,
  LOCAL_CLI_PROVIDER,
  runLocalChat,
  S2_LIVE_MODEL,
  S2_LIVE_PROVIDER,
} from '../src/cli/local-chat';

describe('local CLI adapter', () => {
  it('composes through the canonical context seam with explicit metadata', async () => {
    const result = await runLocalChat({ message: 'What is ready?' });

    expect(result).toMatchObject({
      ok: true,
      trace: {
        provider: LOCAL_CLI_PROVIDER,
        model: LOCAL_CLI_MODEL,
        authority: 'fixed-local-trusted-brief',
        context: 'canonical-context-composer',
        memory: 'owner-bound-local-temporal-snapshot',
        context_layers: [
          'requirements', 'identity', 'approach', 'tools', 'operations', 'voice', 'safety',
        ],
        tools: expect.arrayContaining(['get_crs', 'read_memory']),
        correction: 'trace-only',
        forget: 'trace-only',
        scheduling: 'trace-only',
      },
    });
    if (!result.ok) throw new Error('local chat should compose');
    expect(result.text).not.toContain('0123456789abcdef');
    expect(result.text).not.toContain('fedcba9876543210');
    expect(result.text).not.toContain('0011223344556677');
    expect(result.text).not.toContain('local frozen staged brief content.');
  });

  it('fails the live route without a key and without falling back', async () => {
    const priorKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    let result;
    try {
      result = await runLocalChat({
        message: 'What is ready?',
        provider: S2_LIVE_PROVIDER,
        model: S2_LIVE_MODEL,
      });
    } finally {
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
    }

    expect(result).toMatchObject({
      ok: false,
      error: 'OpenAI request failed: auth_failed',
      trace: { provider: S2_LIVE_PROVIDER, model: S2_LIVE_MODEL },
    });
    if (result.ok) throw new Error('live route unexpectedly succeeded');
    expect(result.error).not.toContain('Local context composed');
  });

  it('rejects empty messages before composing context', async () => {
    await expect(runLocalChat({ message: '  ' })).resolves.toMatchObject({
      ok: false,
      error: 'message must not be empty',
    });
  });
});