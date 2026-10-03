// The runtime owns invocation identity. A model never supplies an operation UUID.
export const workspaceOperationId = async (parts: readonly unknown[], kind = 'workspace_write'): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify([kind, ...parts]));
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32).split('');
  h[12] = '4'; h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
};
