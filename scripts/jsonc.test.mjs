import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseJsonc } from './jsonc.mjs';

test('comments and trailing commas go; slashes and quotes inside strings stay', () => {
  const text = `{
    // a line comment
    "url": "https://example.test/a//b", /* a block
    comment */ "quoted": "say \\"//not a comment\\"",
    "list": [1, 2,],
    "tail": [3, // last
    ],
  }`;
  assert.deepEqual(parseJsonc(text), { url: 'https://example.test/a//b', quoted: 'say "//not a comment"', list: [1, 2], tail: [3] });
});

test('a comma inside a string before a bracket is kept', () => {
  assert.deepEqual(parseJsonc('{"a": ",]", "b": ", }"}'), { a: ',]', b: ', }' });
});

test('the runtime Wrangler config parses, staging vars included', () => {
  const config = parseJsonc(readFileSync('packages/runtime/wrangler.jsonc', 'utf8'));
  assert.equal(config.vars.WALDO_ENVIRONMENT, 'production');
  assert.equal(config.env.staging.vars.WALDO_ENVIRONMENT, 'staging');
});
