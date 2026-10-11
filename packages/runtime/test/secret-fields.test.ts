import { describe, expect, it } from 'vitest';
import { isSecretField } from '../src/channels/secret-fields';

describe('isSecretField', () => {
  it('marks password inputs and credential autocomplete tokens', () => {
    expect(isSecretField({ type: 'password' })).toBe(true);
    expect(isSecretField({ type: 'PASSWORD' })).toBe(true);
    for (const token of ['one-time-code', 'current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'])
      expect(isSecretField({ type: 'text', autocomplete: `section-pay billing ${token.toUpperCase()}` })).toBe(true);
  });

  it('leaves ordinary fields visible', () => {
    expect(isSecretField({})).toBe(false);
    expect(isSecretField({ type: 'text', autocomplete: 'email' })).toBe(false);
    for (const token of ['cc-name', 'cc-type', 'username', 'postal-code', 'off', 'one-time'])
      expect(isSecretField({ type: 'text', autocomplete: token })).toBe(false);
  });
});
