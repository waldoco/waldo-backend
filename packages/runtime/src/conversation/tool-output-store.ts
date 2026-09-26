// Large tool outputs are stored, not inlined: the model gets a head slice plus a reference
// and reads ranges on demand with read_tool_output. In-memory per responder; outputs are
// re-derivable by re-calling the tool, so durability adds nothing here.
export type StoredPut = Readonly<{ id: string; stored_chars: number; original_chars: number; truncated: boolean }>;

export type ToolOutputStore = Readonly<{
  put(output: string): StoredPut;
  read(id: string, offset: number, length: number): Readonly<{ text: string; total: number; original_chars: number; truncated: boolean; next_offset: number | null }> | null;
  // Typed store provenance (owner review on #212): the ONLY authority on whether a stored-output
  // id exists and what span is actually retrievable. A marker string inside tool output text is
  // provider content and proves nothing - callers verify ids here before promising retrieval.
  stat(id: string): StoredPut | null;
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
  const originals = new Map<string, number>();
  let total = 0;
  let next = 0;
  return {
    put(output) {
      next += 1;
      const id = `to-${next}`;
      // never a silent slice: callers get the stored length and the truncation flag and the
      // receipt/read-back contract must carry them (a claimed full length for a stored prefix
      // is a lie the model will plan against)
      const truncated = output.length > MAX_STORED_ITEM_CHARS;
      const stored = truncated ? output.slice(0, MAX_STORED_ITEM_CHARS) : output;
      outputs.set(id, stored);
      originals.set(id, output.length);
      total += stored.length;
      for (const oldest of outputs.keys()) {
        if (total <= MAX_STORED_OUTPUT_CHARS || outputs.size <= 1) break;
        if (oldest === id) break;
        total -= outputs.get(oldest)?.length ?? 0;
        outputs.delete(oldest);
        originals.delete(oldest);
      }
      return { id, stored_chars: stored.length, original_chars: output.length, truncated };
    },
    stat(id) {
      const stored = outputs.get(id);
      if (stored === undefined) return null;
      const original = originals.get(id) ?? stored.length;
      return { id, stored_chars: stored.length, original_chars: original, truncated: original > stored.length };
    },
    read(id, offset, length) {
      const output = outputs.get(id);
      if (output === undefined) return null;
      const text = output.slice(offset, offset + length);
      const end = offset + text.length;
      const original = originals.get(id) ?? output.length;
      return { text, total: output.length, original_chars: original, truncated: original > output.length, next_offset: end < output.length ? end : null };
    },
  };
};
