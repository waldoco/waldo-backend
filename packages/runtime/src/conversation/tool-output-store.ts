// Large tool outputs are stored, not inlined: the model gets a head slice plus a reference
// and reads ranges on demand with read_tool_output. In-memory per responder; outputs are
// re-derivable by re-calling the tool, so durability adds nothing here.
export type ToolOutputStore = Readonly<{
  put(output: string): string;
  read(id: string, offset: number, length: number): Readonly<{ text: string; total: number; next_offset: number | null }> | null;
}>;

export const inMemoryToolOutputStore = (): ToolOutputStore => {
  const outputs = new Map<string, string>();
  let next = 0;
  return {
    put(output) {
      next += 1;
      const id = `to-${next}`;
      outputs.set(id, output);
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
