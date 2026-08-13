#!/usr/bin/env node
process.argv[2] = 'execution';
await import('./run-responsibility-v0-4-generator.mjs');
