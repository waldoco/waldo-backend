import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  formatLocalChatResult,
  LOCAL_CLI_MODEL,
  LOCAL_CLI_PROVIDER,
  runLocalChat,
} from './local-chat';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write('Usage: pnpm --filter @waldo/runtime cli [--provider NAME] [--model NAME]\n');
    stdout.write('Default: local-fake/local-fake-v1. OpenAI live route requires OPENAI_API_KEY.\n');
    return;
  }

  const provider = option(argv, '--provider') ?? LOCAL_CLI_PROVIDER;
  const model = option(argv, '--model') ?? LOCAL_CLI_MODEL;
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`Waldo local chat (${provider}/${model}). Type /exit to quit.\n`);
    stdout.write('> ');
    for await (const message of readline) {
      if (message.trim() === '/exit') return;
      stdout.write(`${formatLocalChatResult(await runLocalChat({ message, provider, model }))}\n`);
      stdout.write('> ');
    }
  } finally {
    readline.close();
  }
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = argv[index + 1];
  if (index === -1) return undefined;
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();