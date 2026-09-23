// The console signs in by typed code. Supabase's default email carries only a magic link, so a
// missing template leaves the user with no code to type (found in the 2026-09-24 local run).
import { readFileSync } from 'node:fs';

const NAME = 'guard-otp-template';
const config = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
const path = /\[auth\.email\.template\.magic_link\][^[]*content_path = "\.\/supabase\/([^"]+)"/.exec(config)?.[1];
const template = path ? readFileSync(new URL(`../../supabase/${path}`, import.meta.url), 'utf8') : '';
if (!template.includes('{{ .Token }}')) {
  process.stderr.write(`${NAME}: the magic_link email template must include {{ .Token }} so console sign-in has a code\n`);
  process.exit(1);
}
process.stdout.write(`${NAME}: ok\n`);
