export default {
  // This mutation lane selects observable contract decisions: cap scope routing, durable
  // counter source, and exact active/terminal journal-outbox state mapping. It deliberately
  // excludes duplicate dispatch predicates and terminal-branch plumbing, whose syntactic
  // mutants are not distinct delivery-policy decisions.
  mutate: [
    'src/delivery-gate/gate.ts:63:1-79:4',
    'src/delivery-gate/store.ts:42:1-76:4',
    'src/run-journal/outbox-runtime.ts:558:1-566:4',
    'src/run-journal/outbox-runtime.ts:569:1-584:4',
  ],
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  coverageAnalysis: 'off',
  // Worker-test DO fixtures share the local harness process, so mutation cases must stay serial.
  concurrency: 1,
  vitest: {
    configFile: 'vitest.delivery-gate.config.ts',
    related: false,
  },
  reporters: ['clear-text'],
  thresholds: {
    high: 100,
    low: 100,
    break: 100,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
