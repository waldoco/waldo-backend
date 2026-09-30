// Run with node --import tsx. Stdout is a catalog; this entrypoint never overwrites files.
import { buildPromptCatalog } from './catalog.ts';

if (process.argv.length !== 3) throw new Error('usage: node --import tsx evals/prompt-experiments/generate.mjs <source-commit-sha>');
process.stdout.write(`${JSON.stringify(buildPromptCatalog(process.argv[2]), null, 2)}\n`);
