import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Deno's deployed connector has no workspace import map. Walk its actual local runtime
// imports so a future edge-shared helper cannot accidentally introduce one indirectly.
test('connector-proxy local runtime dependency graph has no bare workspace imports', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const pending = [resolve(root, 'supabase/functions/connector-proxy/index.ts')];
  const seen = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/import\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(!specifier.startsWith('@waldo/'), `${path} imports ${specifier} without a Deno import map`);
      if (specifier.startsWith('.')) pending.push(resolve(dirname(path), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
    }
  }
  assert.ok(seen.has(resolve(root, 'packages/runtime/src/connectors/google.ts')));
});
