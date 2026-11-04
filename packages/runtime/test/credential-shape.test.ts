import { expect, it } from 'vitest';
import { validModelCredential } from '../src/llm/credential-shape';
it('accepts only nonempty ASCII token characters without normalization', () => {
  for (const value of ['test-key', 'sk-proj-SYNTHETIC_ONLY.123']) expect(validModelCredential(value)).toBe(true);
  for (const value of [undefined, null, 12, '', ' ', 'test-key\u2028', 'test-key\u2029', 'test-key\n', 'test-key\r', 'test-key\0', 'test key', 'test:key', 'test-key\t']) expect(validModelCredential(value)).toBe(false);
});
