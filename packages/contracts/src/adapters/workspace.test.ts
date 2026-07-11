import { describe, expect, it } from 'vitest';
import { workspaceFileSchema } from './workspace';

describe('workspaceFile', () => {
  it('admits only logical static files and a kebab-case user skill descriptor', () => {
    expect(workspaceFileSchema.parse({ kind: 'today' })).toEqual({ kind: 'today' });
    expect(workspaceFileSchema.parse({ kind: 'user_skill', name: 'weekly-review' })).toEqual({
      kind: 'user_skill',
      name: 'weekly-review',
    });
  });
});
