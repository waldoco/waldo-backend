import { expect, it } from 'vitest';
import { TASK_SOURCE_INSTRUCTION } from '../src/channels/task-source-scope';

// SOURCE layer only: pins the prompt contract. Model behaviour is graded on staging traces, not here.
it('names a specific website or URL as an explicit web family and keeps vague lookups uncertain', () => {
  expect(TASK_SOURCE_INSTRUCTION).toContain('names a specific website or URL to open, read or fill in explicitly identifies web and browser');
  expect(TASK_SOURCE_INSTRUCTION).toContain('look something up names no family and stays uncertain');
});
