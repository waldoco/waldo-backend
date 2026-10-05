import { expect, it } from 'vitest';
import { TASK_SOURCE_INSTRUCTION } from '../src/channels/task-source-scope';

// SOURCE layer only: pins the prompt contract. Model behaviour is graded on staging traces, not here.
it('names a specific website or URL as an explicit web family and keeps vague lookups uncertain', () => {
  expect(TASK_SOURCE_INSTRUCTION).toContain('names a specific website or URL to open, read or fill in explicitly identifies the web family');
  expect(TASK_SOURCE_INSTRUCTION).toContain('look something up names no family and stays uncertain');
});

it('does not claim web additions need the owner card, matching the code that exempts web', () => {
  expect(TASK_SOURCE_INSTRUCTION).toContain('connected source families other than web requires');
  expect(TASK_SOURCE_INSTRUCTION).not.toContain('web and browser');
});
