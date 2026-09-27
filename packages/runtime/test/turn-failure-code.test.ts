import { describe, expect, it } from 'vitest';
import { turnFailureCode } from '../src/channels/turn-failure-code';

describe('turnFailureCode (capture-off diagnostics)', () => {
  it('extracts the typed compose failure code and nothing else', () => {
    expect(turnFailureCode(new Error('conversation context failed: health_context_invalid'))).toBe('context_failed:health_context_invalid');
    expect(turnFailureCode(new Error('conversation context failed: mandatory_context_missing'))).toBe('context_failed:mandatory_context_missing');
  });

  it('never leaks free-form content: unknown shapes classify as unknown', () => {
    expect(turnFailureCode(new Error('provider said something about the owner'))).toBe('unknown');
    expect(turnFailureCode('a thrown string with owner text')).toBe('unknown');
    expect(turnFailureCode(undefined)).toBe('unknown');
    expect(turnFailureCode(new Error('conversation context failed: INJECTED TEXT!!'))).toBe('unknown');
  });

  it('classifies the known internal shapes', () => {
    expect(turnFailureCode(new Error('Wrong number of parameter bindings for SQL query.'))).toBe('sql_binding_mismatch');
    expect(turnFailureCode(new Error('illegal transition RUN_OPENED -> DONE'))).toBe('journal_transition');
    expect(turnFailureCode(new Error('conversation model returned empty output'))).toBe('model_empty');
    expect(turnFailureCode(new Error('conversation owner authentication mismatch'))).toBe('owner_mismatch');
    expect(turnFailureCode(new Error('conversation invocation owner mismatch'))).toBe('owner_mismatch');
    expect(turnFailureCode(new Error('turn timed out after 60000 ms'))).toBe('turn_timeout');
  });
});
