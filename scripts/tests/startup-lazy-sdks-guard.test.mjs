import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../guards/guard-startup-lazy-sdks.mjs', import.meta.url));

const check = (source) => {
  const dir = mkdtempSync(join(tmpdir(), 'startup-lazy-sdks-'));
  try {
    writeFileSync(join(dir, 'module.ts'), source);
    return spawnSync(process.execPath, [guard, '--root', dir], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

const rejected = (source, specifier) => {
  const result = check(source);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.split('\n').some((line) => line.startsWith('guard-startup-lazy-sdks: ') && line.includes(specifier)), result.stderr);
};
const accepted = (source) => {
  const result = check(source);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^guard-startup-lazy-sdks: ok/);
};

test('rejects every static value form of a lazy-only package', () => {
  rejected("import { acquire } from '@cloudflare/playwright';\n", '@cloudflare/playwright');
  rejected("import * as sdk from '@cloudflare/playwright';\n", '@cloudflare/playwright');
  rejected("import Docx, { type Table } from 'docx';\n", 'docx');
  rejected("import {\n  PDFDocument,\n  type PDFFont,\n} from 'pdf-lib';\n", 'pdf-lib');
  rejected("import 'pdf-lib';\n", 'pdf-lib');
  rejected("export * from 'docx';\n", 'docx');
  rejected("export { Packer } from 'docx/build';\n", 'docx/build');
  rejected("const { Packer } = require('docx');\n", 'docx');
});

test('accepts type-only imports, dynamic imports and unrelated packages', () => {
  accepted("import type { Browser } from '@cloudflare/playwright';\n");
  accepted("import { type Browser, type Page } from '@cloudflare/playwright';\n");
  accepted("export type { PDFFont } from 'pdf-lib';\n");
  accepted("const { Packer } = await import('docx');\n");
  accepted("type Sdk = typeof import('@cloudflare/playwright');\n");
  accepted("import { z } from 'zod';\nimport { docxLike } from './docx';\n");
});

test('a missing root is a usage error, not a pass', () => {
  const result = spawnSync(process.execPath, [guard, '--root'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});
