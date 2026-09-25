// Large tool outputs are stored, not inlined: the model gets a head slice plus a reference
// and reads ranges on demand with read_tool_output. In-memory per responder; outputs are
// re-derivable by re-calling the tool, so durability adds nothing here.
export type ToolOutputStore = Readonly<{
  put(output: string): string;
  read(id: string, offset: number, length: number): Readonly<{ text: string; total: number; next_offset: number | null }> | null;
}>;

// Aggregate budget: input preparation bounds each string and node count, but without a total
// cap a long run could accumulate unbounded guarded outputs in the responder's memory. Evict
// oldest-first once the budget is exceeded; a stored output is re-derivable by re-calling the
// tool, so eviction is a cache miss (not_found), not data loss. The newest entry is always
// kept even if it alone exceeds the budget (the pre-storage guard already bounds item size).
export const MAX_STORED_OUTPUT_CHARS = 512_000;

// Per-item bound on the post-redaction text, enforced here independently of the pre-storage
// guard (defense in depth): nothing larger is ever held, whatever path called put.
export const MAX_STORED_ITEM_CHARS = 65_536;

export const inMemoryToolOutputStore = (): ToolOutputStore => {
  const outputs = new Map<string, string>();
  let total = 0;
  let next = 0;
  return {
    put(output) {
      next += 1;
      const id = `to-${next}`;
      const stored = output.length > MAX_STORED_ITEM_CHARS ? output.slice(0, MAX_STORED_ITEM_CHARS) : output;
      outputs.set(id, stored);
      total += stored.length;
      for (const oldest of outputs.keys()) {
        if (total <= MAX_STORED_OUTPUT_CHARS || outputs.size <= 1) break;
        if (oldest === id) break;
        total -= outputs.get(oldest)?.length ?? 0;
        outputs.delete(oldest);
      }
      return id;
    },
    read(id, offset, length) {
      const output = outputs.get(id);
      if (output === undefined) return null;
      const text = output.slice(offset, offset + length);
      const end = offset + text.length;
      return { text, total: output.length, next_offset: end < output.length ? end : null };
    },
  };
};
