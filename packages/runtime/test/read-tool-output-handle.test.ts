import { readToolOutputArgsSchema } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { inMemoryToolOutputStore } from '../src/conversation/tool-output-store';
import { readToolOutputHandler } from '../src/tools/read-tool-output';

// A truncated result names its handle `stored_output`; read_tool_output takes it as `id`. The schema stays strict and
// has no alias, so the tool's description is where the model learns which value goes in which field.
describe('read_tool_output handle', () => {
  const handler = readToolOutputHandler(inMemoryToolOutputStore());

  it('says that id is the stored_output value of a truncated result', () => {
    expect(handler.description).toMatch(/\bid\b/);
    expect(handler.description).toContain('stored_output');
  });

  it('accepts an id with an optional offset and length', () => {
    expect(readToolOutputArgsSchema.safeParse({ id: 'to-1' }).success).toBe(true);
    expect(readToolOutputArgsSchema.safeParse({ id: 'to-1', offset: 4_000, length: 2_000 }).success).toBe(true);
  });

  it('rejects the result\'s field name, a missing id, and out-of-range paging', () => {
    expect(readToolOutputArgsSchema.safeParse({ stored_output: 'to-1' }).success).toBe(false);
    expect(readToolOutputArgsSchema.safeParse({ id: 'to-1', stored_output: 'to-1' }).success).toBe(false);
    expect(readToolOutputArgsSchema.safeParse({}).success).toBe(false);
    expect(readToolOutputArgsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(readToolOutputArgsSchema.safeParse({ id: 'x'.repeat(65) }).success).toBe(false);
    expect(readToolOutputArgsSchema.safeParse({ id: 'to-1', offset: -1 }).success).toBe(false);
    expect(readToolOutputArgsSchema.safeParse({ id: 'to-1', length: 16_001 }).success).toBe(false);
  });

  it('pages the value a truncated result named stored_output, and refuses an id it never stored', async () => {
    const store = inMemoryToolOutputStore();
    const kept = store.put('0123456789'.repeat(1_000), { call_id: 'call-1' });
    const receipt = { stored_output: kept.id, read_with: 'read_tool_output' };
    const paged = await readToolOutputHandler(store).handle({ id: receipt.stored_output, offset: 10, length: 20 });
    expect(paged).toMatchObject({ ok: true, data: { text: '01234567890123456789', total: 10_000 } });
    expect(await readToolOutputHandler(store).handle({ id: 'to-999' })).toMatchObject({ ok: false, code: 'not_found' });
  });
});
