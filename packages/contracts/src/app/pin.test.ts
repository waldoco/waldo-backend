import { expect, it } from 'vitest';
// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { readdirSync, readFileSync } from 'node:fs';
// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { URL } from 'node:url';

// @ts-expect-error TS2339 -- Vitest runs this test in Node with import.meta.url
const here = new URL('./', import.meta.url);
const sources = (readdirSync(here) as string[]).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort();
const specifiersOf = (text: string) =>
  [...text.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)].map(match => match[1] ?? match[2] ?? match[3] ?? '');

it('app contracts import only zod and sibling app files, so the app can pin this directory verbatim', () => {
  expect(sources).toEqual(['approvals.ts', 'controls.ts', 'core.ts', 'parts.ts', 'surfaces.ts']);
  for (const name of sources) {
    const specifiers = specifiersOf(readFileSync(new URL(name, here), 'utf8'));
    expect(specifiers).toContain('zod');
    for (const specifier of specifiers) {
      const sibling = specifier.startsWith('./') && sources.includes(`${specifier.slice(2)}.ts`);
      expect({ name, specifier, allowed: specifier === 'zod' || sibling }).toEqual({ name, specifier, allowed: true });
    }
  }
});

it('detects an import from outside the app directory', () => {
  expect(specifiersOf("import { x } from '../runtime/reply-parts';\nimport type { Y } from './parts';")).toEqual(['../runtime/reply-parts', './parts']);
});
