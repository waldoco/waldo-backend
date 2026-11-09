// Agent mail embeds Waldo's mark from a generated module, because the Worker bundle has no rule for .png files. The
// module must carry exactly the committed PNG's bytes and its 1x size. `--write` regenerates it after the PNG changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = 'guard-agent-mail-mark';
const dir = new URL('../../packages/runtime/src/channels/agent-mail/', import.meta.url);
const png = readFileSync(new URL('waldo-mark@2x.png', dir));
const signature = png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
if (!signature || width % 2 || height % 2) {
  process.stderr.write(`${NAME}: waldo-mark@2x.png must be a PNG with even dimensions (found ${width}x${height})\n`);
  process.exit(1);
}
const output = '// Generated from waldo-mark@2x.png by scripts/guards/guard-agent-mail-mark.mjs --write. Shown at half its pixel size.\n'
  + `export const WALDO_MARK_WIDTH = ${width / 2};\nexport const WALDO_MARK_HEIGHT = ${height / 2};\n`
  + `export const WALDO_MARK_PNG_BASE64 =\n  '${png.toString('base64')}';\n`;
const target = new URL('mark.ts', dir);
if (process.argv.includes('--write')) writeFileSync(fileURLToPath(target), output);
else if (readFileSync(target, 'utf8') !== output) {
  process.stderr.write(`${NAME}: agent-mail/mark.ts does not match waldo-mark@2x.png; run node scripts/guards/guard-agent-mail-mark.mjs --write\n`);
  process.exit(1);
}
process.stdout.write(`${NAME}: ok\n`);
